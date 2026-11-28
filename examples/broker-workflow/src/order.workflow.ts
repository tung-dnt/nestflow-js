import { Logger } from '@nestjs/common';
import { Entity, OnEvent, Workflow } from 'nestflow-js/core';

export const ORDER_ENTITY = 'entity.order';

export type OrderState = 'draft' | 'submitted' | 'finished' | 'failed';
export interface Order {
  id: string;
  status: OrderState;
}

type OrderEvent = 'order.submit' | 'order.finish';

@Workflow<Order, OrderEvent, OrderState>({
  name: 'OrderWorkflow',
  entityService: ORDER_ENTITY,
  states: { finals: ['finished', 'failed'], idles: [], failed: 'failed' },
  transitions: [
    { event: 'order.submit', from: ['draft'], to: 'submitted' },
    { event: 'order.finish', from: ['submitted'], to: 'finished' },
  ],
})
export class OrderWorkflow {
  private readonly logger = new Logger(OrderWorkflow.name);

  @OnEvent('order.submit')
  async submit(@Entity() order: Order): Promise<{ orderId: string }> {
    this.logger.log(`Submitted order ${order.id}`);
    return { orderId: order.id };
  }

  @OnEvent('order.finish')
  async finish(@Entity() order: Order): Promise<void> {
    this.logger.log(`Finished order ${order.id}`);
  }
}
