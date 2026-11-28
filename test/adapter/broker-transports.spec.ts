import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import {
  createAzureServiceBusAdapter,
  createGcpPubSubAdapter,
  createRabbitMQAdapter,
  InvalidWorkflowMessageError,
  type RabbitMQChannel,
} from '@/adapter';
import type { IWorkflowEvent, TransitResult } from '@/core';
import { WorkflowCancelledException } from '@/exception';
import { describe, expect, test, vi } from 'vite-plus/test';

const event = {
  event: 'order.submit',
  urn: 'order-123',
  eventId: 'producer-event-123',
  attempt: 0,
  payload: { name: 'cà phê' },
} satisfies IWorkflowEvent<unknown>;
const finalResult: TransitResult = { status: 'final', state: 'done' };
const content = Buffer.from(JSON.stringify(event));
const queue = 'orders';
const subscription = 'projects/test/subscriptions/orders';

type Delivery = { content: Buffer };
type Channel = RabbitMQChannel<Delivery>;

function rabbitChannel() {
  const returned = new EventEmitter();
  const channel = {
    get: vi.fn<Channel['get']>().mockResolvedValue(false),
    ack: vi.fn<Channel['ack']>(),
    reject: vi.fn<Channel['reject']>(),
    on: returned.on.bind(returned),
    sendToQueue: vi.fn<Channel['sendToQueue']>().mockReturnValue(true),
  } satisfies Channel;
  return { channel, returned };
}

describe('RabbitMQ transport', () => {
  test('waits for broker confirmation and rejects an unroutable return even when RabbitMQ confirms it', async () => {
    const { channel, returned } = rabbitChannel();
    const { publish } = createRabbitMQAdapter({ channel, queue, consume: vi.fn() });
    const accepted = vi.fn();
    const first = publish(event).then(accepted);
    const second = publish(event);
    const [routed, unroutable] = channel.sendToQueue.mock.calls;
    expect(routed?.slice(0, 3)).toEqual([
      queue,
      content,
      { mandatory: true, persistent: true, contentType: 'application/json', correlationId: expect.any(String) },
    ]);
    expect(unroutable?.[2].correlationId).not.toEqual(routed?.[2].correlationId);
    await setImmediate();
    expect(accepted).not.toHaveBeenCalled();

    if (!routed || !unroutable) throw new Error('Expected both broker publishes');
    returned.emit('return', { properties: { correlationId: unroutable[2].correlationId } });
    unroutable[3](null);
    routed[3](null);

    await expect(second).rejects.toThrow('RabbitMQ could not route');
    await first;
    expect(accepted).toHaveBeenCalledOnce();
  });

  test('propagates a negative broker confirmation', async () => {
    const { channel } = rabbitChannel();
    const { publish } = createRabbitMQAdapter({ channel, queue, consume: vi.fn() });
    const failure = new Error('publish rejected');
    const publishing = publish(event);
    const sent = channel.sendToQueue.mock.lastCall;
    if (!sent) throw new Error('Expected a broker publish');
    sent[3](failure);
    await expect(publishing).rejects.toBe(failure);
  });

  test('acknowledges only after the consumer succeeds', async () => {
    const { channel } = rabbitChannel();
    const message = { content };
    channel.get.mockResolvedValueOnce(message);
    const commit = Promise.withResolvers<TransitResult>();
    const consume = vi.fn(() => commit.promise);
    const delivery = createRabbitMQAdapter({ channel, queue, consume }).consumeOne();
    await setImmediate();
    expect(channel.get).toHaveBeenCalledWith(queue, { noAck: false });
    expect(consume).toHaveBeenCalledExactlyOnceWith(event);
    expect(channel.ack).not.toHaveBeenCalled();

    commit.resolve(finalResult);
    await expect(delivery).resolves.toBe(true);
    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(message);
    expect(channel.reject).not.toHaveBeenCalled();
  });

  test('drops cancelled work, publishes the continuation before acknowledging, and requeues a failed handoff', async () => {
    const { channel } = rabbitChannel();
    const next = { ...event, event: 'order.finish', eventId: 'continuation-1' };
    const message = { content };
    channel.get.mockResolvedValue(message);
    channel.sendToQueue
      .mockImplementation((_queue, _body, _options, confirm) => {
        confirm(undefined);
        return true;
      })
      .mockImplementationOnce((_queue, _body, _options, confirm) => {
        confirm(new Error('broker unavailable'));
        return true;
      });
    const consume = vi
      .fn<(raw: unknown) => Promise<TransitResult>>()
      .mockResolvedValue({ status: 'continued', nextEvent: next })
      .mockRejectedValueOnce(new WorkflowCancelledException());
    const { consumeOne } = createRabbitMQAdapter({ channel, queue, consume });

    await expect(consumeOne()).resolves.toBe(true);
    expect(channel.ack).toHaveBeenCalledExactlyOnceWith(message);
    await expect(consumeOne()).rejects.toThrow('broker unavailable');
    expect(channel.reject).toHaveBeenCalledExactlyOnceWith(message, true);
    await expect(consumeOne()).resolves.toBe(true);
    expect(channel.sendToQueue).toHaveBeenLastCalledWith(
      queue,
      Buffer.from(JSON.stringify(next)),
      expect.anything(),
      expect.any(Function),
    );
    expect(channel.ack).toHaveBeenCalledTimes(2);
  });

  test('dead-letters malformed input and requeues transient failures', async () => {
    const { channel } = rabbitChannel();
    const malformed = { content: Buffer.from('{') };
    const invalid = { content: Buffer.from('{}') };
    const valid = { content };
    channel.get.mockResolvedValueOnce(malformed).mockResolvedValueOnce(invalid).mockResolvedValueOnce(valid);
    const unavailable = new Error('database unavailable');
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new InvalidWorkflowMessageError('Missing eventId'))
      .mockRejectedValueOnce(unavailable);
    const { consumeOne } = createRabbitMQAdapter({ channel, queue, consume });

    await expect(consumeOne()).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
    await expect(consumeOne()).resolves.toBe(true);
    await expect(consumeOne()).rejects.toBe(unavailable);
    await expect(consumeOne()).resolves.toBe(false);
    expect(channel.reject.mock.calls).toEqual([
      [malformed, false],
      [invalid, false],
      [valid, true],
    ]);
    expect(channel.ack).not.toHaveBeenCalled();
  });
});

describe('Azure Service Bus transport', () => {
  test('configures host settlement and only completes when the workflow consumer succeeds', async () => {
    const unavailable = new Error('database unavailable');
    const invalid = new InvalidWorkflowMessageError('Missing eventId');
    const consume = vi
      .fn()
      .mockResolvedValueOnce(finalResult)
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(invalid);
    const { trigger } = createAzureServiceBusAdapter({
      sender: { sendMessages: vi.fn() },
      connection: 'ServiceBusConnection',
      queueName: queue,
      consume,
    });
    expect(trigger).toMatchObject({
      connection: 'ServiceBusConnection',
      queueName: queue,
      cardinality: 'one',
      autoCompleteMessages: true,
    });
    await expect(trigger.handler(content)).resolves.toBeUndefined();
    await expect(trigger.handler(event)).rejects.toBe(unavailable);
    await expect(trigger.handler('{')).rejects.toBeInstanceOf(SyntaxError);
    await expect(trigger.handler('{}')).rejects.toBe(invalid);
    expect(consume.mock.calls).toEqual([[event], [event], [{}]]);
  });

  test('preserves the producer eventId and propagates a failed send', async () => {
    const send = Promise.withResolvers<void>();
    const sendMessages = vi.fn(() => send.promise);
    const { publish } = createAzureServiceBusAdapter({
      sender: { sendMessages },
      connection: 'ServiceBusConnection',
      queueName: queue,
      consume: vi.fn(),
    });
    const publishing = publish(event);
    expect(sendMessages).toHaveBeenCalledExactlyOnceWith({ body: content, contentType: 'application/json' });
    const unavailable = new Error('Service Bus unavailable');
    send.reject(unavailable);
    await expect(publishing).rejects.toBe(unavailable);
  });
});

describe('Google Pub/Sub transport', () => {
  test('acknowledges a valid wrapped push without substituting the Pub/Sub message ID', async () => {
    const consume = vi.fn().mockResolvedValue(finalResult);
    const { consumePush } = createGcpPubSubAdapter({ topic: { publishMessage: vi.fn() }, subscription, consume });
    const body = { subscription, message: { messageId: 'google-assigned-id', data: content.toString('base64') } };
    await expect(consumePush(body)).resolves.toBe(204);
    expect(consume).toHaveBeenCalledExactlyOnceWith(event);
  });

  test('negative-acknowledges malformed pushes and keeps processing failures visible', async () => {
    const distributedFailure = new Error('database unavailable');
    const consume = vi
      .fn()
      .mockRejectedValueOnce(new InvalidWorkflowMessageError('Missing eventId'))
      .mockRejectedValueOnce(distributedFailure);
    const { consumePush } = createGcpPubSubAdapter({ topic: { publishMessage: vi.fn() }, subscription, consume });
    const body = { subscription, message: { data: content.toString('base64') } };
    await expect(consumePush({ ...body, subscription: 'unrelated' })).resolves.toBe(400);
    await expect(consumePush({ ...body, message: { data: 'A?==' } })).resolves.toBe(400);
    await expect(consumePush({ ...body, message: { data: Buffer.from('{').toString('base64') } })).resolves.toBe(400);
    expect(consume).not.toHaveBeenCalled();
    await expect(consumePush({ ...body, message: { data: Buffer.from('{}').toString('base64') } })).resolves.toBe(400);
    await expect(consumePush(body)).rejects.toBe(distributedFailure);
  });

  test('preserves the producer eventId and propagates a failed publish', async () => {
    const send = Promise.withResolvers<string>();
    const publishMessage = vi.fn(() => send.promise);
    const { publish } = createGcpPubSubAdapter({ topic: { publishMessage }, subscription, consume: vi.fn() });
    const publishing = publish(event);
    expect(publishMessage).toHaveBeenCalledExactlyOnceWith({ data: content });
    const unavailable = new Error('Pub/Sub unavailable');
    send.reject(unavailable);
    await expect(publishing).rejects.toBe(unavailable);
  });
});
