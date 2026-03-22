import { Logger } from '@nestjs/common';
import { Entity, OnDefault, OnEvent, Payload, Workflow } from '@/core';

import type { Subscription } from './subscription.entity';
import { SubscriptionEntityService, SubscriptionState } from './subscription.entity';

export enum SubscriptionEvent {
  TRIAL_STARTED = 'subscription.trial.started',
  TRIAL_ENDED = 'subscription.trial.ended',
  ACTIVATED = 'subscription.activated',
  PAYMENT_FAILED = 'subscription.payment.failed',
  PAYMENT_SUCCEEDED = 'subscription.payment.succeeded',
  SUSPENDED = 'subscription.suspended',
  REACTIVATED = 'subscription.reactivated',
  CANCELLED = 'subscription.cancelled',
  EXPIRED = 'subscription.expired',
}

export const SUBSCRIPTION_ENTITY_TOKEN = 'entity.subscription';

@Workflow<Subscription, SubscriptionEvent, SubscriptionState>({
  name: 'SubscriptionWorkflow',
  states: {
    finals: [SubscriptionState.CANCELLED, SubscriptionState.EXPIRED],
    idles: [SubscriptionState.TRIAL, SubscriptionState.ACTIVE, SubscriptionState.SUSPENDED],
    failed: SubscriptionState.FAILED,
  },
  transitions: [
    {
      event: SubscriptionEvent.TRIAL_ENDED,
      from: [SubscriptionState.TRIAL],
      to: SubscriptionState.ACTIVE,
      conditions: [
        (entity: Subscription, payload?: { paymentMethodId: string }) => payload?.paymentMethodId !== undefined,
      ],
    },
    {
      event: SubscriptionEvent.TRIAL_ENDED,
      from: [SubscriptionState.TRIAL],
      to: SubscriptionState.EXPIRED,
      conditions: [
        (_entity: Subscription, payload?: { paymentMethodId: string }) => payload?.paymentMethodId === undefined,
      ],
    },
    {
      event: SubscriptionEvent.PAYMENT_FAILED,
      from: [SubscriptionState.ACTIVE],
      to: SubscriptionState.SUSPENDED,
    },
    {
      event: SubscriptionEvent.PAYMENT_SUCCEEDED,
      from: [SubscriptionState.SUSPENDED],
      to: SubscriptionState.ACTIVE,
    },
    {
      event: SubscriptionEvent.CANCELLED,
      from: [SubscriptionState.ACTIVE, SubscriptionState.SUSPENDED],
      to: SubscriptionState.CANCELLED,
    },
  ],
  entityService: SUBSCRIPTION_ENTITY_TOKEN,
})
export class SubscriptionWorkflow {
  private readonly logger = new Logger(SubscriptionWorkflow.name);

  constructor() {}

  @OnEvent(SubscriptionEvent.TRIAL_STARTED)
  async handleTrialStarted(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} trial started`);
    return { trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() }; // 14 days
  }

  @OnEvent(SubscriptionEvent.TRIAL_ENDED)
  async handleTrialEnded(@Entity() subscription: Subscription, @Payload() payload: any) {
    this.logger.log(`Subscription ${subscription.id} trial ended`);
    return { paymentMethodId: payload?.paymentMethodId };
  }

  @OnEvent(SubscriptionEvent.ACTIVATED)
  async handleActivated(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} activated`);
    return { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }; // 30 days
  }

  @OnEvent(SubscriptionEvent.PAYMENT_FAILED)
  async handlePaymentFailed(@Entity() subscription: Subscription, @Payload() payload: any) {
    this.logger.log(`Subscription ${subscription.id} payment failed`);
    return { gracePeriodEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() };
  }

  @OnEvent(SubscriptionEvent.PAYMENT_SUCCEEDED)
  async handlePaymentSucceeded(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} payment succeeded`);
    return { currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  }

  @OnEvent(SubscriptionEvent.SUSPENDED)
  async handleSuspended(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} suspended`);
    return { suspendedAt: new Date().toISOString() };
  }

  @OnEvent(SubscriptionEvent.REACTIVATED)
  async handleReactivated(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} reactivated`);
    return { reactivatedAt: new Date().toISOString() };
  }

  @OnEvent(SubscriptionEvent.CANCELLED)
  async handleCancelled(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} cancelled`);
    return { cancelledAt: new Date().toISOString() };
  }

  @OnEvent(SubscriptionEvent.EXPIRED)
  async handleExpired(@Entity() subscription: Subscription) {
    this.logger.log(`Subscription ${subscription.id} expired`);
    return { expiresAt: new Date().toISOString() };
  }

  @OnDefault
  async fallback(entity: Subscription, event: string, payload?: any) {
    this.logger.warn(`Fallback called for subscription ${entity.id} on event ${event}`);
    return entity;
  }
}
