import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { PubSub } from '@google-cloud/pubsub';
import { createGcpPubSubAdapter } from 'nestflow-js/adapter';
import { closeApp, consume } from './app.js';

const topicName = process.env.PUBSUB_TOPIC;
const subscription = process.env.PUBSUB_SUBSCRIPTION;
if (!topicName || !subscription) throw new Error('Set PUBSUB_TOPIC and the full PUBSUB_SUBSCRIPTION name');

const pubsub = new PubSub();
const { consumePush } = createGcpPubSubAdapter({
  topic: pubsub.topic(topicName, { gaxOpts: { timeout: 5_000, retry: null } }),
  subscription,
  consume,
});
const decoder = new TextDecoder('utf-8', { fatal: true });

async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  // Require Cloud Run IAM authentication; never deploy this service with public access.
  if (request.url !== '/pubsub') {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected an HTTP request byte stream');
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) {
      response.writeHead(413, { Connection: 'close' }).end();
      return;
    }
    chunks.push(chunk);
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(decoder.decode(Buffer.concat(chunks, bytes)));
  } catch {
    response.writeHead(400).end();
    return;
  }
  response.writeHead(await consumePush(envelope)).end();
}

const server = createServer((request, response) => {
  void respond(request, response).catch((error: unknown) => {
    console.error('Workflow HTTP request failed', error);
    response.writeHead(503).end();
  });
});
server.listen(Number(process.env.PORT ?? 8080), process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');

function stop(): void {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  server.close(() => {
    void Promise.all([pubsub.close(), closeApp()]).catch((error: unknown) => {
      console.error('Workflow host shutdown failed', error);
      process.exitCode = 1;
    });
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
