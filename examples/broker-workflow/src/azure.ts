import { app } from '@azure/functions';
import { ServiceBusClient } from '@azure/service-bus';
import { createAzureServiceBusAdapter } from 'nestflow-js/adapter';
import { closeApp, consume } from './app.js';

const connection = 'ServiceBusConnection';
const connectionString = process.env[connection];
const queueName = process.env.SERVICE_BUS_QUEUE;
if (!connectionString || !queueName) throw new Error('Set ServiceBusConnection and SERVICE_BUS_QUEUE');

const client = new ServiceBusClient(connectionString, { retryOptions: { timeoutInMs: 5_000, maxRetries: 0 } });
const { trigger } = createAzureServiceBusAdapter({
  sender: client.createSender(queueName),
  connection,
  queueName,
  consume,
});

app.serviceBusQueue('consumeWorkflow', trigger);
app.hook.appTerminate(async () => {
  await Promise.all([closeApp(), client.close()]);
});
