import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { Injectable } from '@nestjs/common';
import { EntityParser, GetItemCommand } from 'dynamodb-toolbox';
import type {
  IWorkflowEntity,
  RecoveryClaim,
  TransitionClaim,
  TransitionReceipt,
  WorkflowHistoryEntry,
  WorkflowHistoryReader,
  WorkflowCancellationStore,
  WorkflowRecoveryStore,
} from 'nestflow-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

import { DocumentClient } from '../dynamodb/client.js';
import { type Order, OrderEntity, OrderState, OrderTable } from '../dynamodb/order.table.js';

const tableName = OrderTable.getName();
const orderParser = OrderEntity.build(EntityParser);
const receiptPrefix = 'transition#';
// shortcut: fixed lease without renewal, add renewal if handlers cannot finish within it.
const leaseMs = 60_000;
const orderAvailable =
  'attribute_exists(#status) AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)';
const statusAttribute = { '#status': 'status' };
const indexName = 'WorkflowRecords';
const pendingGroup = 'recovery#pending';
const orderKeyAt = (time: number, id: string) => `${String(time).padStart(16, '0')}#${id}`;
const historyGroup = (urn: string | number) => `history#${String(urn)}`;

function parseHistory(value: unknown): WorkflowHistoryEntry {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('workflow' in value) ||
    typeof value.workflow !== 'string' ||
    !('event' in value) ||
    typeof value.event !== 'string' ||
    !('eventId' in value) ||
    typeof value.eventId !== 'string' ||
    !('urn' in value) ||
    typeof value.urn !== 'string' ||
    !('from' in value) ||
    typeof value.from !== 'string' ||
    !('to' in value) ||
    typeof value.to !== 'string' ||
    !('committedAtMs' in value) ||
    typeof value.committedAtMs !== 'number' ||
    !('outcome' in value)
  ) {
    throw new Error('Invalid workflow history record');
  }
  const { workflow, event, eventId, urn, from, to, committedAtMs, outcome } = value;
  if (outcome !== 'applied' && outcome !== 'unretriable' && outcome !== 'exhausted') {
    throw new Error('Invalid workflow history outcome');
  }
  return { workflow, event, eventId, urn, from, to, committedAtMs, outcome };
}

function decodeOutput(outputJson: unknown): unknown {
  if (outputJson === undefined) return undefined;
  if (typeof outputJson !== 'string') throw new Error('Invalid order transition output');
  return JSON.parse(outputJson);
}

async function readTransition(
  orderKey: { id: string },
  receiptKey: { id: string },
): Promise<{ order?: Record<string, unknown>; receipt?: TransitionReceipt<Order> }> {
  const { Responses } = await DocumentClient.send(
    new TransactGetCommand({
      TransactItems: [{ Get: { TableName: tableName, Key: orderKey } }, { Get: { TableName: tableName, Key: receiptKey } }],
    }),
  );
  const order = Responses?.[0]?.Item;
  const item = Responses?.[1]?.Item;
  if (!item) return { order };

  const entity: Order = orderParser.parse(item.entity, { fill: false }).item;
  const kind: unknown = item.kind;
  switch (kind) {
    case 'applied':
      return { order, receipt: { entity, completion: { kind, output: decodeOutput(item.outputJson) } } };
    case 'unretriable':
    case 'exhausted':
      return { order, receipt: { entity, completion: { kind } } };
    default:
      throw new Error('Invalid order transition receipt');
  }
}

@Injectable()
export class OrderEntityService implements IWorkflowEntity<Order, OrderState>, WorkflowHistoryReader, WorkflowRecoveryStore {
  readonly cancellation: WorkflowCancellationStore = {
    request: async (urn) => {
      try {
        await DocumentClient.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { id: String(urn) },
            ConditionExpression: 'attribute_exists(#status)',
            UpdateExpression: 'SET cancellationRequested = :requested',
            ExpressionAttributeNames: statusAttribute,
            ExpressionAttributeValues: { ':requested': true },
          }),
        );
        return true;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return false;
        throw error;
      }
    },
    isRequested: async (urn) => {
      const { Item } = await DocumentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { id: String(urn) },
          ProjectionExpression: 'cancellationRequested',
          ConsistentRead: true,
        }),
      );
      return Item?.cancellationRequested === true;
    },
  };

  async listTransitions(urn: string | number, limit: number, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('History limit must be 1–100');
    const group = historyGroup(urn);
    if (cursor && !/^[0-9]{16}#transition#[a-f0-9]{64}$/.test(cursor)) throw new Error('Invalid history cursor');
    const page = await DocumentClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: 'recordGroup = :group AND recordOrder > :cursor',
      ExpressionAttributeValues: { ':group': group, ':cursor': cursor ?? '0' },
      Limit: limit,
    }));
    const entries = await Promise.all((page.Items ?? []).map(async ({ id }) => {
      const { Item } = await DocumentClient.send(new GetCommand({
        TableName: tableName, Key: { id }, ConsistentRead: true, ProjectionExpression: 'history',
      }));
      return parseHistory(Item?.history);
    }));
    const next: unknown = page.LastEvaluatedKey?.recordOrder;
    return { entries, cursor: typeof next === 'string' ? next : undefined };
  }

  async claimPending(): Promise<RecoveryClaim | undefined> {
    const now = Date.now();
    const page = await DocumentClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: 'recordGroup = :group AND recordOrder <= :due',
      ExpressionAttributeValues: { ':group': pendingGroup, ':due': orderKeyAt(now, '~') },
      Limit: 10,
    }));

    for (const candidate of page.Items ?? []) {
      const id: unknown = candidate.id;
      if (typeof id !== 'string') throw new Error('Invalid recovery key');
      const owner = randomUUID();
      const availableAt = now + leaseMs;
      let item;
      try {
        ({ Attributes: item } = await DocumentClient.send(new UpdateCommand({
          TableName: tableName,
          Key: { id },
          ConditionExpression: 'recordGroup = :group AND availableAt <= :now',
          UpdateExpression: 'SET recoveryOwner = :owner, availableAt = :available, recordOrder = :order',
          ExpressionAttributeValues: {
            ':group': pendingGroup, ':now': now, ':owner': owner, ':available': availableAt,
            ':order': orderKeyAt(availableAt, id),
          },
          ReturnValues: 'ALL_NEW',
        })));
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) continue;
        throw error;
      }
      const transition = parseHistory(item?.history);
      const receiptId: unknown = item?.receiptId;
      if (typeof receiptId !== 'string') throw new Error('Invalid recovery receipt key');
      const { receipt } = await readTransition({ id: String(transition.urn) }, { id: receiptId });
      if (!receipt || receipt.completion.kind !== 'applied') throw new Error('Missing recovery receipt');
      return {
        transition,
        receipt,
        acknowledge: async () => {
          await DocumentClient.send(new DeleteCommand({
            TableName: tableName,
            Key: { id },
            ConditionExpression: 'recoveryOwner = :owner AND availableAt > :now',
            ExpressionAttributeValues: { ':owner': owner, ':now': Date.now() },
          }));
        },
      };
    }
  }

  async create(): Promise<Order> {
    const order: Order = {
      id: uuidv7(),
      quantity: 0,
      item: 'ahihihi',
      price: 0,
      status: OrderState.PENDING,
    };
    await DocumentClient.send(new PutCommand({
      TableName: tableName,
      Item: order,
      ConditionExpression: 'attribute_not_exists(id)',
    }));
    return order;
  }

  async load(urn: string | number): Promise<Order | null> {
    const id = String(urn);
    if (id.startsWith(receiptPrefix) || id.startsWith('recovery#')) return null;
    const { Item } = await OrderEntity.build(GetItemCommand).key({ id }).options({ consistent: true }).send();
    return Item ?? null;
  }

  async update(order: Order, status: OrderState): Promise<Order> {
    const { Attributes } = await DocumentClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { id: order.id },
        UpdateExpression: 'SET #status = :status REMOVE leaseOwner, leaseExpiresAt',
        ConditionExpression: orderAvailable,
        ExpressionAttributeNames: statusAttribute,
        ExpressionAttributeValues: { ':status': status, ':now': Date.now() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return orderParser.parse(Attributes, { fill: false }).item;
  }

  async claimTransition(urn: string | number, eventId: string): Promise<TransitionClaim<Order, OrderState>> {
    const key = { id: String(urn) };
    if (key.id.startsWith(receiptPrefix) || key.id.startsWith('recovery#')) return { kind: 'missing' };
    const digest = createHash('sha256').update(JSON.stringify([key.id, eventId])).digest('hex');
    const receiptKey = { id: `${receiptPrefix}${digest}` };
    const prior = await readTransition(key, receiptKey);
    if (prior.order?.cancellationRequested === true) return { kind: 'cancelled' };
    if (prior.receipt) return { kind: 'completed', receipt: prior.receipt };
    if (!prior.order) return { kind: 'missing' };

    const owner = randomUUID();
    const now = Date.now();
    const expiresAt = now + leaseMs;
    try {
      await DocumentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :expiresAt',
          ConditionExpression: `${orderAvailable} AND attribute_not_exists(cancellationRequested)`,
          ExpressionAttributeNames: statusAttribute,
          ExpressionAttributeValues: { ':owner': owner, ':expiresAt': expiresAt, ':now': now },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const observed = await readTransition(key, receiptKey);
      if (observed.order?.cancellationRequested === true) return { kind: 'cancelled' };
      if (observed.receipt) return { kind: 'completed', receipt: observed.receipt };
      return observed.order ? { kind: 'busy' } : { kind: 'missing' };
    }

    const release = async (): Promise<void> => {
      try {
        await DocumentClient.send(new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: 'REMOVE leaseOwner, leaseExpiresAt',
          ConditionExpression: 'leaseOwner = :owner',
          ExpressionAttributeValues: { ':owner': owner },
        }));
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
    };

    let receipt: TransitionReceipt<Order> | undefined;
    try {
      // A previous owner may have committed between our first read and the lease update.
      const observed = await readTransition(key, receiptKey);
      receipt = observed.receipt;
      if (!receipt && Date.now() < expiresAt) {
        if (observed.order?.leaseOwner !== owner || observed.order.leaseExpiresAt !== expiresAt) {
          throw new Error('Order transition lease was lost during acquisition');
        }
        const entity: Order = orderParser.parse(observed.order, { fill: false }).item;
        return {
          kind: 'acquired',
          entity,
          async commit(status, completion, metadata, recordHistory) {
            const updated: Order = orderParser.parse({ ...entity, id: key.id, status }).item;
            const output = completion.kind === 'applied' ? completion.output : undefined;
            const outputJson = output === undefined ? undefined : JSON.stringify(output);
            if (output !== undefined && outputJson === undefined) {
              throw new Error('Order transition output is not JSON-serializable');
            }
            const commitTime = Date.now();
            if (commitTime >= expiresAt) throw new Error('Order transition lease expired');
            const history: WorkflowHistoryEntry = {
              ...metadata, urn: key.id, to: status, committedAtMs: commitTime, outcome: completion.kind,
            };
            const recoveryId = `recovery#${digest}`;
            await DocumentClient.send(new TransactWriteCommand({
              ClientRequestToken: owner,
              TransactItems: [
                {
                  Update: {
                    TableName: tableName,
                    Key: key,
                    UpdateExpression:
                      'SET #status = :status, #item = :item, quantity = :quantity, price = :price REMOVE leaseOwner, leaseExpiresAt',
                    ConditionExpression: 'leaseOwner = :owner AND leaseExpiresAt > :now',
                    ExpressionAttributeNames: { ...statusAttribute, '#item': 'item' },
                    ExpressionAttributeValues: {
                      ':owner': owner,
                      ':now': commitTime,
                      ':status': updated.status,
                      ':item': updated.item,
                      ':quantity': updated.quantity,
                      ':price': updated.price,
                    },
                  },
                },
                {
                  Put: {
                    TableName: tableName,
                    Item: {
                      ...receiptKey,
                      entity: updated,
                      kind: completion.kind,
                      outputJson,
                      ...(recordHistory && {
                        history,
                        recordGroup: historyGroup(key.id),
                        recordOrder: orderKeyAt(commitTime, receiptKey.id),
                      }),
                    },
                    ConditionExpression: 'attribute_not_exists(id)',
                  },
                },
                ...(process.env.WORKFLOW_RECOVERY === 'true' && completion.kind === 'applied' ? [{
                  Put: {
                    TableName: tableName,
                    Item: {
                      id: recoveryId, history, receiptId: receiptKey.id, availableAt: commitTime,
                      recordGroup: pendingGroup, recordOrder: orderKeyAt(commitTime, recoveryId),
                    },
                    ConditionExpression: 'attribute_not_exists(id)',
                  },
                }] : []),
              ],
            }));
            return {
              entity: updated,
              completion: completion.kind === 'applied' ? { kind: 'applied', output: decodeOutput(outputJson) } : completion,
            };
          },
          release,
        };
      }
    } catch (cause) {
      try {
        await release();
      } catch (error) {
        throw new AggregateError([cause, error], 'Could not read order transition or release its lease', { cause });
      }
      throw cause;
    }
    await release();
    return receipt ? { kind: 'completed', receipt } : { kind: 'busy' };
  }

  status(order: Order): OrderState {
    return order.status;
  }

  urn(order: Order): string | number {
    return order.id;
  }
}
