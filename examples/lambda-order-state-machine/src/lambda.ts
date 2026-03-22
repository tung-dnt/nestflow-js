import { NestFactory } from '@nestjs/core';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { DurableLambdaEventHandler } from 'nestjs-serverless-workflow/adapter';
import { OrderModule } from './order/order.module';

const app = await NestFactory.createApplicationContext(OrderModule);
await app.init();

export const handler = DurableLambdaEventHandler(app, withDurableExecution);
