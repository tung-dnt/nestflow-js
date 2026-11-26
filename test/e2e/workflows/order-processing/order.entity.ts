import { Injectable } from '@nestjs/common';
import { InMemoryWorkflowEntity } from '../../fixtures/in-memory-workflow-entity';

export enum OrderState {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SHIPPED = 'shipped',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export interface Order {
  id: string;
  status: OrderState;
  items: Array<{ name: string; quantity: number; price: number }>;
  totalAmount: number;
  customerId: string;
  approved?: boolean;
  shippedAt?: string;
  cancelledAt?: string;
}

/**
 * In-memory entity service for testing
 */
@Injectable()
export class OrderEntityService extends InMemoryWorkflowEntity<Order, 'status'> {
  constructor() {
    super('status');
  }

  async create(): Promise<Order> {
    const order: Order = {
      id: `order-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      status: OrderState.PENDING,
      items: [],
      totalAmount: 0,
      customerId: `customer-${Math.random().toString(36).substr(2, 9)}`,
    };
    return this.save(order);
  }
}
