import { type Observable, defer } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type {
  IWorkflowEntity,
  RecoveryClaim,
  TransitionClaim,
  TransitionReceipt,
  WorkflowRecoveryStore,
} from 'nestflow-js/core';
import pg, { type PoolClient } from 'pg';

import type { Order, OrderState } from './order.workflow.js';

type OrderRow = { id: unknown; status: unknown };
type ReceiptRow = OrderRow & { outcome: unknown; output_json: unknown };
type PendingRow = ReceiptRow & { workflow: unknown; event: unknown; event_id: unknown; from_status: unknown };

function parseOrder({ id, status }: OrderRow): Order {
  if (
    typeof id !== 'string' ||
    (status !== 'draft' && status !== 'submitted' && status !== 'finished' && status !== 'failed')
  ) {
    throw new Error('Invalid workflow order row');
  }
  return { id, status };
}

function parseReceipt(row: ReceiptRow): TransitionReceipt<Order> {
  const entity = parseOrder(row);
  const kind = row.outcome;
  switch (kind) {
    case 'applied': {
      const json = row.output_json;
      if (json !== null && typeof json !== 'string') throw new Error('Invalid workflow receipt output');
      const output: unknown = json === null ? undefined : JSON.parse(json);
      return { entity, completion: { kind, output } };
    }
    case 'unretriable':
    case 'exhausted':
      return { entity, completion: { kind } };
    default:
      throw new Error('Invalid workflow receipt outcome');
  }
}

async function readReceipt(
  client: PoolClient,
  id: string,
  eventId: string,
): Promise<TransitionReceipt<Order> | undefined> {
  const {
    rows: [row],
  } = await client.query<ReceiptRow>(
    `SELECT order_id AS id, to_status AS status, outcome, output_json
       FROM workflow_transitions WHERE order_id = $1 AND event_id = $2`,
    [id, eventId],
  );
  return row && parseReceipt(row);
}

@Injectable()
export class PostgresOrderStore
  implements IWorkflowEntity<Order, OrderState>, WorkflowRecoveryStore, OnApplicationShutdown
{
  private readonly pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.pool = new pg.Pool({ connectionString, allowExitOnIdle: true });
    const logger = new Logger(PostgresOrderStore.name);
    this.pool.on('error', (error) => logger.error(error));
  }

  onApplicationShutdown(): Promise<void> {
    return this.pool.end();
  }

  create(): Observable<Order> {
    return defer(async () => {
      const order: Order = { id: randomUUID(), status: 'draft' };
      await this.pool.query('INSERT INTO workflow_orders (id, status) VALUES ($1, $2)', [order.id, order.status]);
      return order;
    });
  }

  load(urn: string | number): Observable<Order | null> {
    return defer(async () => {
      const {
        rows: [row],
      } = await this.pool.query<OrderRow>('SELECT id, status FROM workflow_orders WHERE id = $1', [String(urn)]);
      return row ? parseOrder(row) : null;
    });
  }

  update(order: Order, status: OrderState): Observable<Order> {
    return defer(async () => {
      const {
        rows: [row],
      } = await this.pool.query<OrderRow>('UPDATE workflow_orders SET status = $2 WHERE id = $1 RETURNING id, status', [
        order.id,
        status,
      ]);
      if (!row) throw new Error(`Order ${order.id} not found`);
      return parseOrder(row);
    });
  }

  status(order: Order): OrderState {
    return order.status;
  }

  urn(order: Order): string {
    return order.id;
  }

  claimTransition(urn: string | number, eventId: string): Observable<TransitionClaim<Order, OrderState>> {
    return defer<Promise<TransitionClaim<Order, OrderState>>>(async () => {
      const id = String(urn);
      const client = await this.pool.connect();
      let closed = false;
      const release = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        try {
          await client.query('ROLLBACK');
        } catch (error) {
          client.release(true);
          throw error;
        }
        client.release();
      };

      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        let row: OrderRow | undefined;
        try {
          ({
            rows: [row],
          } = await client.query<OrderRow>('SELECT id, status FROM workflow_orders WHERE id = $1 FOR UPDATE NOWAIT', [
            id,
          ]));
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== '55P03') throw error;
          await client.query('ROLLBACK');
          const receipt = await readReceipt(client, id, eventId);
          closed = true;
          client.release();
          return receipt ? { kind: 'completed', receipt } : { kind: 'busy' };
        }
        if (!row) {
          await release();
          return { kind: 'missing' };
        }

        // Read after taking the lock so a concurrent commit cannot slip past the receipt check.
        const receipt = await readReceipt(client, id, eventId);
        if (receipt) {
          await release();
          return { kind: 'completed', receipt };
        }

        // shortcut: hold a transaction through the handler, use renewable leases for long-running handlers.
        return {
          kind: 'acquired',
          entity: parseOrder(row),
          commit(status, completion, metadata) {
            return defer<Promise<TransitionReceipt<Order>>>(async () => {
              if (closed) throw new Error('Order transition claim is closed');
              const output = completion.kind === 'applied' ? completion.output : undefined;
              const outputJson = JSON.stringify(output);
              if (output !== undefined && outputJson === undefined)
                throw new Error('Workflow output is not JSON-serializable');
              await client.query('UPDATE workflow_orders SET status = $2 WHERE id = $1', [id, status]);
              const {
                rows: [stored],
              } = await client.query<ReceiptRow>(
                `INSERT INTO workflow_transitions
               (order_id, event_id, workflow, event, from_status, to_status, outcome, output_json, available_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     CASE WHEN $7 = 'applied' THEN statement_timestamp() END)
             RETURNING order_id AS id, to_status AS status, outcome, output_json`,
                [id, eventId, metadata.workflow, metadata.event, metadata.from, status, completion.kind, outputJson],
              );
              const receipt = parseReceipt(stored);
              await client.query('COMMIT');
              closed = true;
              client.release();
              return receipt;
            });
          },
          release: () => defer(release),
        };
      } catch (error) {
        if (!closed) client.release(true);
        throw error;
      }
    });
  }

  claimPending(): Observable<RecoveryClaim | undefined> {
    return defer(async () => {
      const owner = randomUUID();
      // shortcut: fixed recovery lease may republish after a slow handoff, add renewal for longer publishes.
      const {
        rows: [row],
      } = await this.pool.query<PendingRow>(
        `WITH candidate AS (
         SELECT order_id, event_id FROM workflow_transitions
         WHERE available_at <= statement_timestamp()
         ORDER BY available_at
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE workflow_transitions AS w
       SET available_at = statement_timestamp() + interval '5 seconds', recovery_owner = $1
       FROM candidate AS c
       WHERE w.order_id = c.order_id AND w.event_id = c.event_id
       RETURNING w.order_id AS id, w.to_status AS status, w.outcome, w.output_json,
                 w.workflow, w.event, w.event_id, w.from_status`,
        [owner],
      );
      if (!row) return undefined;

      const receipt = parseReceipt(row);
      const { workflow, event, event_id: eventId, from_status: from } = row;
      if (
        receipt.completion.kind !== 'applied' ||
        typeof workflow !== 'string' ||
        typeof event !== 'string' ||
        typeof eventId !== 'string' ||
        typeof from !== 'string'
      ) {
        throw new Error('Invalid pending workflow transition');
      }
      const urn = receipt.entity.id;
      return {
        transition: { workflow, event, eventId, urn, from },
        receipt,
        acknowledge: () =>
          defer(async () => {
            const { rowCount } = await this.pool.query(
              `UPDATE workflow_transitions SET available_at = NULL, recovery_owner = NULL
           WHERE order_id = $1 AND event_id = $2 AND recovery_owner = $3 AND available_at > statement_timestamp()`,
              [urn, eventId, owner],
            );
            if (rowCount !== 1) throw new Error('Workflow transition recovery lease expired or lost');
          }),
      };
    });
  }
}
