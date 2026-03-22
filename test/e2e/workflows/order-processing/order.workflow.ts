import { Logger } from '@nestjs/common';
import { Entity, OnDefault, OnEvent, Payload, Workflow } from '@/core';
import { UnretriableException } from '@/exception';

import type { Order } from './order.entity';
import { OrderEntityService, OrderState } from './order.entity';

export enum OrderEvent {
  CREATED = 'order.created',
  APPROVED = 'order.approved',
  PROCESSING = 'order.processing',
  SHIPPED = 'order.shipped',
  CANCELLED = 'order.cancelled',
}

export const ORDER_ENTITY_TOKEN = 'entity.order';

@Workflow<Order, OrderEvent, OrderState>({
  name: 'OrderWorkflow',
  states: {
    finals: [OrderState.SHIPPED, OrderState.CANCELLED],
    idles: [OrderState.PENDING],
    failed: OrderState.FAILED,
  },
  transitions: [
    {
      event: OrderEvent.CREATED,
      from: [OrderState.PENDING],
      to: OrderState.PROCESSING,
      conditions: [(entity: Order, payload?: { approved: boolean }) => payload?.approved === true],
    },
    {
      event: OrderEvent.PROCESSING,
      from: [OrderState.PROCESSING],
      to: OrderState.SHIPPED,
    },
    {
      event: OrderEvent.CANCELLED,
      from: [OrderState.PENDING, OrderState.PROCESSING],
      to: OrderState.CANCELLED,
      conditions: [(entity: Order) => entity.status !== OrderState.SHIPPED],
    },
  ],
  entityService: ORDER_ENTITY_TOKEN,
})
export class OrderWorkflow {
  private readonly logger = new Logger(OrderWorkflow.name);

  constructor() {}

  @OnEvent(OrderEvent.CREATED)
  async handleOrderCreated(@Entity() order: Order, @Payload() payload: any) {
    this.logger.log(`Order ${order.id} created and approved`);
    if (order.items.length === 0) {
      throw new UnretriableException('Order must have at least one item');
    }
    return { processedAt: new Date().toISOString() };
  }

  @OnEvent(OrderEvent.PROCESSING)
  async handleOrderProcessing(@Entity() order: Order, @Payload() payload: any) {
    this.logger.log(`Processing order ${order.id}`);
    return { shippedAt: new Date().toISOString() };
  }

  @OnEvent(OrderEvent.CANCELLED)
  async handleOrderCancelled(@Entity() order: Order) {
    this.logger.log(`Order ${order.id} cancelled`);
    return { cancelledAt: new Date().toISOString() };
  }

  @OnDefault
  async fallback(entity: Order, event: string, payload?: any) {
    this.logger.warn(`Fallback called for order ${entity.id} on event ${event}`);
    return entity;
  }
}
