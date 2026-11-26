import { NestFactory } from '@nestjs/core';
import { OrderModule } from './order/order.module.js';

const app = await NestFactory.create(OrderModule);
await app.listen(3000);
