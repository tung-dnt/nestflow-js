import { Injectable } from '@nestjs/common';
import { InMemoryWorkflowEntity } from '../../fixtures/in-memory-workflow-entity';

export enum PaymentState {
  INITIATED = 'initiated',
  AUTHORIZING = 'authorizing',
  CAPTURING = 'capturing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
}

export interface Payment {
  id: string;
  status: PaymentState;
  amount: number;
  currency: string;
  cardNumber?: string;
  authorizationCode?: string;
  captureId?: string;
  refundId?: string;
  errorMessage?: string;
  retryCount: number;
  createdAt?: string;
  completedAt?: string;
  refundedAt?: string;
}

/**
 * In-memory entity service for testing
 */
@Injectable()
export class PaymentEntityService extends InMemoryWorkflowEntity<Payment, 'status'> {
  constructor() {
    super('status');
  }

  async create(): Promise<Payment> {
    const payment: Payment = {
      id: `payment-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      status: PaymentState.INITIATED,
      amount: 0,
      currency: 'USD',
      retryCount: 0,
      createdAt: new Date().toISOString(),
    };
    return this.save(payment);
  }
}
