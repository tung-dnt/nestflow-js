import { Injectable } from '@nestjs/common';
import { InMemoryWorkflowEntity } from '../../fixtures/in-memory-workflow-entity';

export enum SubscriptionState {
  TRIAL = 'trial',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

export interface Subscription {
  id: string;
  status: SubscriptionState;
  userId: string;
  planId: string;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  paymentMethodId?: string;
  gracePeriodEndsAt?: string;
  cancelledAt?: string;
  expiresAt?: string;
  createdAt?: string;
}

/**
 * In-memory entity service for testing
 */
@Injectable()
export class SubscriptionEntityService extends InMemoryWorkflowEntity<Subscription, 'status'> {
  constructor() {
    super('status');
  }

  async create(): Promise<Subscription> {
    const subscription: Subscription = {
      id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      status: SubscriptionState.TRIAL,
      userId: `user-${Math.random().toString(36).substr(2, 9)}`,
      planId: 'plan-basic',
      createdAt: new Date().toISOString(),
    };
    return this.save(subscription);
  }
}
