import { firstValueFrom } from 'rxjs';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { WorkflowModule } from '@/core/workflow.module';
import { OrchestratorService } from '@/core/providers/orchestrator.service';
import { assertEntityState, createWorkflowEvent } from '../../fixtures/test-helpers';
import { SubscriptionWorkflow, SubscriptionEvent, SUBSCRIPTION_ENTITY_TOKEN } from './subscription.workflow';
import { SubscriptionEntityService, SubscriptionState } from './subscription.entity';

describe('Subscription Management Workflow E2E', () => {
  let module: TestingModule;
  let orchestrator: OrchestratorService;
  let entityService: SubscriptionEntityService;

  beforeEach(async () => {
    entityService = new SubscriptionEntityService();

    module = await Test.createTestingModule({
      imports: [
        WorkflowModule.register({
          entities: [{ provide: SUBSCRIPTION_ENTITY_TOKEN, useValue: entityService }],
          workflows: [SubscriptionWorkflow],
        }),
      ],
    }).compile();

    await module.init();
    orchestrator = module.get(OrchestratorService);
  });

  afterEach(async () => {
    entityService.clear();
    await module.close();
  });

  describe('Happy Path - Trial to Active', () => {
    test('should activate subscription after trial: TRIAL → ACTIVE', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Trial ends with payment method
      await firstValueFrom(
        orchestrator.transit(
          createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id, {
            paymentMethodId: 'pm_123',
          }),
        ),
      );

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.ACTIVE);
    });
  });

  describe('Trial Expiration', () => {
    test('should expire subscription when trial ends without payment method', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Trial ends without payment method
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id)));

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.EXPIRED);
    });
  });

  describe('Payment Failure and Suspension', () => {
    test('should suspend active subscription on payment failure: ACTIVE → SUSPENDED', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.ACTIVE));

      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_FAILED, subscription.id)),
      );

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.SUSPENDED);
    });
  });

  describe('Reactivation', () => {
    test('should reactivate suspended subscription: SUSPENDED → ACTIVE', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.SUSPENDED));

      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_SUCCEEDED, subscription.id)),
      );

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.ACTIVE);
    });
  });

  describe('Cancellation', () => {
    test('should cancel active subscription: ACTIVE → CANCELLED', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.ACTIVE));

      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.CANCELLED, subscription.id)));

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.CANCELLED);
    });

    test('should cancel suspended subscription: SUSPENDED → CANCELLED', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.SUSPENDED));

      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.CANCELLED, subscription.id)));

      const updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.CANCELLED);
    });
  });

  describe('Multiple Transitions from Same State', () => {
    test('should handle multiple transitions from ACTIVE state', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.ACTIVE));

      // Can go to SUSPENDED on payment failure
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_FAILED, subscription.id)),
      );
      let updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.SUSPENDED);

      // Reset to ACTIVE
      await firstValueFrom(entityService.update(subscription, SubscriptionState.ACTIVE));

      // Can go to CANCELLED
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.CANCELLED, subscription.id)));
      updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.CANCELLED);
    });

    test('should handle multiple transitions from TRIAL state', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Can go to ACTIVE with payment method
      await firstValueFrom(
        orchestrator.transit(
          createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id, {
            paymentMethodId: 'pm_123',
          }),
        ),
      );
      let updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.ACTIVE);

      // Reset to TRIAL
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Can go to EXPIRED without payment method
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id)));
      updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.EXPIRED);
    });
  });

  describe('Reversible Transitions', () => {
    test('should handle suspension and reactivation cycle: ACTIVE ↔ SUSPENDED', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.ACTIVE));

      // Suspend
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_FAILED, subscription.id)),
      );
      let updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.SUSPENDED);

      // Reactivate
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_SUCCEEDED, subscription.id)),
      );
      updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.ACTIVE);
    });
  });

  describe('Conditional Transitions', () => {
    test('should wait in TRIAL until payment method condition is met', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Try to end trial without payment method
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id)));

      // Should transition to EXPIRED (condition for payment method not met)
      let updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.EXPIRED);

      // Reset to TRIAL
      await firstValueFrom(entityService.update(subscription, SubscriptionState.TRIAL));

      // Now with payment method
      await firstValueFrom(
        orchestrator.transit(
          createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, subscription.id, {
            paymentMethodId: 'pm_456',
          }),
        ),
      );

      updatedSubscription = await firstValueFrom(entityService.load(subscription.id));
      assertEntityState(updatedSubscription!, entityService, SubscriptionState.ACTIVE);
    });
  });

  describe('Error Handling', () => {
    test('should throw error for invalid transition from final state', async () => {
      const subscription = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(subscription, SubscriptionState.CANCELLED));

      // Try to reactivate cancelled subscription
      await expect(
        firstValueFrom(orchestrator.transit(createWorkflowEvent(SubscriptionEvent.PAYMENT_SUCCEEDED, subscription.id))),
      ).rejects.toThrow();
    });

    test('should throw error when entity not found', async () => {
      await expect(
        firstValueFrom(
          orchestrator.transit(createWorkflowEvent(SubscriptionEvent.TRIAL_ENDED, 'non-existent-subscription')),
        ),
      ).rejects.toThrow();
    });
  });
});
