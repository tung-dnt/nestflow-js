import { randomUUID } from 'node:crypto';
import type { IWorkflowEvent } from '@/core';
import { deliverWorkflowMessage, type WorkflowConsumer } from './broker-delivery';
import { InvalidWorkflowMessageError } from './message-workflow.adapter';

interface RabbitMQDelivery {
  content: Buffer;
}

/** The part of an amqplib ConfirmChannel needed by the adapter. */
export interface RabbitMQChannel<Delivery extends RabbitMQDelivery> {
  get(queue: string, options: { noAck: false }): Promise<Delivery | false>;
  ack(message: Delivery): void;
  reject(message: Delivery, requeue: boolean): void;
  on(event: 'return', listener: (message: { properties: { correlationId: unknown } }) => void): unknown;
  sendToQueue(
    queue: string,
    body: Buffer,
    options: { mandatory: true; persistent: true; contentType: string; correlationId: string },
    confirm: (error: unknown) => void,
  ): boolean;
}

export interface RabbitMQAdapterOptions<Delivery extends RabbitMQDelivery> {
  channel: RabbitMQChannel<Delivery>;
  queue: string;
  /** Resolves the transition result; the adapter publishes a continuation before it acknowledges. */
  consume: WorkflowConsumer;
}

export interface RabbitMQAdapter {
  publish: (event: IWorkflowEvent<unknown>) => Promise<void>;
  consumeOne: () => Promise<boolean>;
}

/** Bind a workflow consumer to a declared queue. Create one adapter per app-owned confirm channel. */
export function createRabbitMQAdapter<Delivery extends RabbitMQDelivery>({
  channel,
  queue,
  consume,
}: RabbitMQAdapterOptions<Delivery>): RabbitMQAdapter {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pending = new Map<string, () => void>();
  channel.on('return', ({ properties: { correlationId } }) => {
    if (typeof correlationId === 'string') pending.get(correlationId)?.();
  });

  async function publish(event: IWorkflowEvent<unknown>): Promise<void> {
    const body = Buffer.from(JSON.stringify(event));
    const correlationId = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    // RabbitMQ emits a mandatory return before a confirm for an unroutable publish.
    pending.set(correlationId, () => reject(new Error(`RabbitMQ could not route to queue ${queue}`)));
    try {
      channel.sendToQueue(
        queue,
        body,
        { mandatory: true, persistent: true, contentType: 'application/json', correlationId },
        (error) => (error ? reject(error) : resolve()),
      );
      await promise;
    } finally {
      pending.delete(correlationId);
    }
  }

  async function consumeOne(): Promise<boolean> {
    const message = await channel.get(queue, { noAck: false });
    if (!message) return false;

    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(message.content));
    } catch {
      channel.reject(message, false);
      return true;
    }

    try {
      await deliverWorkflowMessage(consume, publish, raw);
    } catch (error) {
      const invalid = error instanceof InvalidWorkflowMessageError;
      channel.reject(message, !invalid);
      if (!invalid) throw error;
      return true;
    }
    channel.ack(message);
    return true;
  }

  return { publish, consumeOne };
}
