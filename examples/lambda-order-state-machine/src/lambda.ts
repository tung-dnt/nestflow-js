import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { NestFactory } from '@nestjs/core';
import { DurableLambdaEventHandler } from 'nestflow-js/adapter';
import { OrderModule } from './order/order.module.js';

const app = await NestFactory.createApplicationContext(OrderModule);
await app.init();

export const handler = DurableLambdaEventHandler(app, withDurableExecution);
