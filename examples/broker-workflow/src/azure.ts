import { app } from '@azure/functions';
import { ServiceBusClient } from '@azure/service-bus';
import { createAzureServiceBusAdapter } from 'nestflow-js/adapter';
import { closeApp, consume, dispatchOne } from './app.js';

const connection = 'ServiceBusConnection';
const connectionString = process.env[connection];
const queueName = process.env.SERVICE_BUS_QUEUE;
if (!connectionString || !queueName) throw new Error('Set ServiceBusConnection and SERVICE_BUS_QUEUE');

const client = new ServiceBusClient(connectionString, { retryOptions: { timeoutInMs: 5_000, maxRetries: 0 } });
const { trigger, publish } = createAzureServiceBusAdapter({
  sender: client.createSender(queueName),
  connection,
  queueName,
  consume,
});

app.serviceBusQueue('consumeWorkflow', trigger);
app.timer('dispatchWorkflowOutbox', {
  schedule: '*/5 * * * * *',
  handler: async () => {
    const deadline = performance.now() + 10_000;
    for (let count = 0; count < 20 && performance.now() < deadline; count++) {
      if (!(await dispatchOne(publish))) break;
    }
  },
});
app.hook.appTerminate(async () => {
  await Promise.all([closeApp(), client.close()]);
});
