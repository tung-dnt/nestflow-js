import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import amqp from 'amqplib';
import { createRabbitMQAdapter } from 'nestflow-js/adapter';
import { closeApp, consume, createOrder } from './app.js';

async function run(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== 'seed') throw new Error('Usage: node dist/container.js [seed]');
  const url = process.env.AMQP_URL;
  if (!url) throw new Error('Set AMQP_URL');
  const queue = process.env.RABBITMQ_QUEUE ?? 'nestflow-workflow';
  const deadLetterQueue = `${queue}.dead-letter`;
  const connection = await amqp.connect(url, { timeout: 10_000 });
  let connectionClosed = false;
  connection.on('close', () => {
    connectionClosed = true;
  });
  connection.on('error', (error) => console.error('RabbitMQ connection failed', error));

  try {
    const channel = await connection.createConfirmChannel();
    let channelClosed = false;
    channel.on('close', () => {
      channelClosed = true;
    });
    channel.on('error', (error) => console.error('RabbitMQ channel failed', error));
    await channel.assertQueue(deadLetterQueue, { durable: true });
    await channel.assertQueue(queue, {
      durable: true,
      arguments: { 'x-queue-type': 'quorum', 'x-delivery-limit': 8 },
      deadLetterExchange: '',
      deadLetterRoutingKey: deadLetterQueue,
    });
    const { consumeOne, publish } = createRabbitMQAdapter({ channel, consume, queue });

    if (mode === 'seed') {
      const event = { urn: await createOrder(), eventId: randomUUID(), event: 'order.submit', attempt: 0 };
      await publish(event);
      console.info(JSON.stringify(event));
      return;
    }

    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      while (!stopping && !channelClosed && !connectionClosed) {
        let received = false;
        try {
          received = await consumeOne();
        } catch (error) {
          console.error('Workflow delivery failed', error);
        }
        if (!received) {
          await setTimeout(500);
        }
      }
      if (!stopping) throw new Error('RabbitMQ closed the worker channel or connection');
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } finally {
    if (!connectionClosed) await connection.close();
  }
}

try {
  try {
    await run();
  } finally {
    await closeApp();
  }
} catch (error) {
  console.error('Workflow worker stopped', error);
  process.exitCode = 1;
}
