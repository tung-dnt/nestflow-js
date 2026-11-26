import type { IWorkflowEvent } from '@/core';
import { InvalidWorkflowMessageError } from './message-workflow.adapter';

export interface GcpPubSubAdapterOptions {
  /** An app-owned @google-cloud/pubsub Topic for workflow messages. */
  topic: { publishMessage(message: { data: Buffer }): Promise<string> };
  /** The full push subscription name, projects/PROJECT/subscriptions/SUBSCRIPTION. */
  subscription: string;
  consume: (raw: unknown) => Promise<unknown>;
}

export interface GcpPubSubAdapter {
  publish: (event: IWorkflowEvent<unknown>) => Promise<void>;
  /** Consume an authenticated, wrapped Pub/Sub push. Failures must receive a non-2xx response. */
  consumePush: (envelope: unknown) => Promise<204 | 400>;
}

const INVALID_BASE64 = /[^A-Za-z0-9+/=]|=[^=]|={3}/;

/** Decode wrapped Pub/Sub push deliveries and publish through an app-owned topic. */
export function createGcpPubSubAdapter({ topic, subscription, consume }: GcpPubSubAdapterOptions): GcpPubSubAdapter {
  const decoder = new TextDecoder('utf-8', { fatal: true });

  async function publish(event: IWorkflowEvent<unknown>): Promise<void> {
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(event)) });
  }

  async function consumePush(envelope: unknown): Promise<204 | 400> {
    if (
      typeof envelope !== 'object' ||
      !envelope ||
      !('subscription' in envelope) ||
      envelope.subscription !== subscription ||
      !('message' in envelope)
    ) {
      return 400;
    }
    const { message } = envelope;
    if (typeof message !== 'object' || !message || !('data' in message) || typeof message.data !== 'string') {
      return 400;
    }
    const { data } = message;
    if (!data || data.length % 4 !== 0 || INVALID_BASE64.test(data)) return 400;

    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode(Buffer.from(data, 'base64')));
    } catch {
      return 400;
    }
    try {
      await consume(raw);
    } catch (error) {
      if (error instanceof InvalidWorkflowMessageError) return 400;
      throw error;
    }
    return 204;
  }

  return { publish, consumePush };
}
