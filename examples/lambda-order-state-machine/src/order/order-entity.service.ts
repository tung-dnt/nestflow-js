import { defer, type Observable } from 'rxjs';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, TransactGetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Injectable } from '@nestjs/common';
import { EntityParser, GetItemCommand } from 'dynamodb-toolbox';
import type { IWorkflowEntity, TransitionClaim, TransitionReceipt, WorkflowHistoryEntry } from 'nestflow-js/core';
import { createHash, randomUUID } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

import { DocumentClient } from '../dynamodb/client.js';
import { type Order, OrderEntity, OrderState, OrderTable } from '../dynamodb/order.table.js';

const tableName = OrderTable.getName();
const orderParser = OrderEntity.build(EntityParser);
const receiptPrefix = 'transition#';
// shortcut: fixed lease without renewal, add renewal if handlers cannot finish within it.
const leaseMs = 60_000;
const orderAvailable = 'attribute_exists(#status) AND (attribute_not_exists(leaseExpiresAt) OR leaseExpiresAt <= :now)';
const statusAttribute = { '#status': 'status' };

function decodeJson(json: unknown): unknown {
  if (json === undefined) return undefined;
  if (typeof json !== 'string') throw new Error('Invalid order transition receipt');
  return JSON.parse(json);
}

async function readTransition(
  orderKey: { id: string },
  receiptKey: { id: string },
): Promise<{ order?: Record<string, unknown>; receipt?: TransitionReceipt<Order> }> {
  const { Responses } = await DocumentClient.send(
    new TransactGetCommand({
      TransactItems: [
        { Get: { TableName: tableName, Key: orderKey } },
        { Get: { TableName: tableName, Key: receiptKey } },
      ],
    }),
  );
  const order = Responses?.[0]?.Item;
  const item = Responses?.[1]?.Item;
  if (!item) return { order };

  const entity: Order = orderParser.parse(item.entity, { fill: false }).item;
  // Written only by commit() below from an orchestrator-built entry.
  const history = decodeJson(item.historyJson) as WorkflowHistoryEntry | undefined;
  const kind: unknown = item.kind;
  switch (kind) {
    case 'applied':
      return { order, receipt: { entity, completion: { kind, output: decodeJson(item.outputJson) }, history } };
    case 'unretriable':
    case 'exhausted':
      return { order, receipt: { entity, completion: { kind }, history } };
    default:
      throw new Error('Invalid order transition receipt');
  }
}

@Injectable()
export class OrderEntityService implements IWorkflowEntity<Order, OrderState> {
  create(): Observable<Order> {
    return defer(async () => {
      const order: Order = {
        id: uuidv7(),
        quantity: 0,
        item: 'ahihihi',
        price: 0,
        status: OrderState.PENDING,
      };
      await DocumentClient.send(
        new PutCommand({
          TableName: tableName,
          Item: order,
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      return order;
    });
  }

  load(urn: string | number): Observable<Order | null> {
    return defer(async () => {
      const id = String(urn);
      if (id.startsWith(receiptPrefix)) return null;
      const { Item } = await OrderEntity.build(GetItemCommand).key({ id }).options({ consistent: true }).send();
      return Item ?? null;
    });
  }

  update(order: Order, status: OrderState): Observable<Order> {
    return defer(async () => {
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
    });
  }

  claimTransition(urn: string | number, eventId: string): Observable<TransitionClaim<Order, OrderState>> {
    return defer<Promise<TransitionClaim<Order, OrderState>>>(async () => {
      const key = { id: String(urn) };
      if (key.id.startsWith(receiptPrefix)) return { kind: 'missing' };
      const digest = createHash('sha256')
        .update(JSON.stringify([key.id, eventId]))
        .digest('hex');
      const receiptKey = { id: `${receiptPrefix}${digest}` };
      const prior = await readTransition(key, receiptKey);
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
            ConditionExpression: orderAvailable,
            ExpressionAttributeNames: statusAttribute,
            ExpressionAttributeValues: { ':owner': owner, ':expiresAt': expiresAt, ':now': now },
          }),
        );
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
        const observed = await readTransition(key, receiptKey);
        if (observed.receipt) return { kind: 'completed', receipt: observed.receipt };
        return observed.order ? { kind: 'busy' } : { kind: 'missing' };
      }

      const release = async (): Promise<void> => {
        try {
          await DocumentClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: key,
              UpdateExpression: 'REMOVE leaseOwner, leaseExpiresAt',
              ConditionExpression: 'leaseOwner = :owner',
              ExpressionAttributeValues: { ':owner': owner },
            }),
          );
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
            commit(status, completion, history) {
              return defer<Promise<TransitionReceipt<Order>>>(async () => {
                const updated: Order = orderParser.parse({ ...entity, id: key.id, status }).item;
                const output = completion.kind === 'applied' ? completion.output : undefined;
                const outputJson = output === undefined ? undefined : JSON.stringify(output);
                const historyJson = history && JSON.stringify(history);
                if ((output !== undefined && outputJson === undefined) || (history && historyJson === undefined)) {
                  throw new Error('Order transition output or history is not JSON-serializable');
                }
                const commitTime = Date.now();
                if (commitTime >= expiresAt) throw new Error('Order transition lease expired');
                await DocumentClient.send(
                  new TransactWriteCommand({
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
                            historyJson,
                          },
                          ConditionExpression: 'attribute_not_exists(id)',
                        },
                      },
                    ],
                  }),
                );
                return {
                  entity: updated,
                  completion:
                    completion.kind === 'applied' ? { kind: 'applied', output: decodeJson(outputJson) } : completion,
                  history: history && (decodeJson(historyJson) as WorkflowHistoryEntry),
                };
              });
            },
            release: () => defer(release),
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
    });
  }

  status(order: Order): OrderState {
    return order.status;
  }

  urn(order: Order): string | number {
    return order.id;
  }
}
