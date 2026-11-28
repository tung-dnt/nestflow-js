import type { IWorkflowEvent } from '@/core';
import { deliverWorkflowMessage, type WorkflowConsumer } from './broker-delivery';

export interface AzureServiceBusAdapterOptions {
  /** An app-owned ServiceBusSender for workflow messages. */
  sender: { sendMessages(message: { body: Buffer; contentType: string }): Promise<void> };
  /** The name of the Functions app setting, not its secret value. */
  connection: string;
  queueName: string;
  /** Resolves the transition result; the adapter publishes a continuation before the host completes the message. */
  consume: WorkflowConsumer;
}

export interface AzureServiceBusAdapter {
  publish: (event: IWorkflowEvent<unknown>) => Promise<void>;
  trigger: {
    connection: string;
    queueName: string;
    cardinality: 'one';
    autoCompleteMessages: true;
    handler(message: unknown): Promise<void>;
  };
}

/** Build an Azure Functions v4 queue trigger and an awaited Service Bus publisher. */
export function createAzureServiceBusAdapter({
  sender,
  connection,
  queueName,
  consume,
}: AzureServiceBusAdapterOptions): AzureServiceBusAdapter {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  async function publish(event: IWorkflowEvent<unknown>): Promise<void> {
    await sender.sendMessages({ body: Buffer.from(JSON.stringify(event)), contentType: 'application/json' });
  }

  async function handler(message: unknown): Promise<void> {
    const body = Buffer.isBuffer(message) ? decoder.decode(message) : message;
    const raw: unknown = typeof body === 'string' ? JSON.parse(body) : body;
    // The host completes on success and redelivers failures up to the queue's MaxDeliveryCount.
    await deliverWorkflowMessage(consume, publish, raw);
  }

  return { publish, trigger: { connection, queueName, cardinality: 'one', autoCompleteMessages: true, handler } };
}
