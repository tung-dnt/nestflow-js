import { firstValueFrom } from 'rxjs';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { WorkflowModule } from '@/core/workflow.module';
import { OrchestratorService } from '@/core/providers/orchestrator.service';
import { MockRetryHandler } from '../fixtures/mock-retry-handler.service';
import { assertEntityState, createWorkflowEvent } from '../fixtures/test-helpers';

// Import all workflows
import { OrderWorkflow, OrderEvent, ORDER_ENTITY_TOKEN } from '../workflows/order-processing/order.workflow';
import { OrderEntityService, OrderState } from '../workflows/order-processing/order.entity';
import {
  UserOnboardingWorkflow,
  OnboardingEvent,
  ONBOARDING_ENTITY_TOKEN,
} from '../workflows/user-onboarding/onboarding.workflow';
import { UserEntityService, OnboardingState } from '../workflows/user-onboarding/user.entity';
import {
  PaymentWorkflow,
  PaymentEvent,
  PAYMENT_ENTITY_TOKEN,
  PAYMENT_RETRY_HANDLER_TOKEN,
} from '../workflows/payment-processing/payment.workflow';
import { PaymentEntityService, PaymentState } from '../workflows/payment-processing/payment.entity';

describe('Multi-Workflow Integration E2E', () => {
  let module: TestingModule;
  let orchestrator: OrchestratorService;
  let orderEntityService: OrderEntityService;
  let userEntityService: UserEntityService;
  let paymentEntityService: PaymentEntityService;
  let retryHandler: MockRetryHandler;

  beforeEach(async () => {
    retryHandler = new MockRetryHandler();
    orderEntityService = new OrderEntityService();
    userEntityService = new UserEntityService();
    paymentEntityService = new PaymentEntityService();

    module = await Test.createTestingModule({
      imports: [
        WorkflowModule.register({
          entities: [
            { provide: ORDER_ENTITY_TOKEN, useValue: orderEntityService },
            { provide: ONBOARDING_ENTITY_TOKEN, useValue: userEntityService },
            { provide: PAYMENT_ENTITY_TOKEN, useValue: paymentEntityService },
          ],
          workflows: [OrderWorkflow, UserOnboardingWorkflow, PaymentWorkflow],
        }),
      ],
      providers: [{ provide: PAYMENT_RETRY_HANDLER_TOKEN, useValue: retryHandler }],
    }).compile();

    await module.init();
    orchestrator = module.get(OrchestratorService);
  });

  afterEach(async () => {
    orderEntityService.clear();
    userEntityService.clear();
    paymentEntityService.clear();
    retryHandler.clearRetries();
    await module.close();
  });

  describe('Multiple Workflows in Same Module', () => {
    test('should handle order and user onboarding workflows simultaneously', async () => {
      // Create order
      const order = await firstValueFrom(orderEntityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 100 }];
      await firstValueFrom(orderEntityService.update(order, OrderState.PENDING));

      // Create user
      const user = await firstValueFrom(userEntityService.create());
      await firstValueFrom(userEntityService.update(user, OnboardingState.REGISTRATION));

      // Process order
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));
      let updatedOrder = await firstValueFrom(orderEntityService.load(order.id));
      assertEntityState(updatedOrder!, orderEntityService, OrderState.PROCESSING);

      // Process user onboarding
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.REGISTERED, user.id)));
      let updatedUser = await firstValueFrom(userEntityService.load(user.id));
      assertEntityState(updatedUser!, userEntityService, OnboardingState.EMAIL_VERIFICATION);

      // Continue order processing
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.PROCESSING, order.id)));
      updatedOrder = await firstValueFrom(orderEntityService.load(order.id));
      assertEntityState(updatedOrder!, orderEntityService, OrderState.SHIPPED);

      // Continue user onboarding
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.EMAIL_VERIFIED, user.id)));
      updatedUser = await firstValueFrom(userEntityService.load(user.id));
      assertEntityState(updatedUser!, userEntityService, OnboardingState.PROFILE_SETUP);
    });

    test('should handle order, user, and payment workflows simultaneously', async () => {
      // Create entities
      const order = await firstValueFrom(orderEntityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 100 }];
      await firstValueFrom(orderEntityService.update(order, OrderState.PENDING));

      const user = await firstValueFrom(userEntityService.create());
      await firstValueFrom(userEntityService.update(user, OnboardingState.REGISTRATION));

      const payment = await firstValueFrom(paymentEntityService.create());
      payment.amount = 100;
      await firstValueFrom(paymentEntityService.update(payment, PaymentState.INITIATED));

      // Process all workflows
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.REGISTERED, user.id)));
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(PaymentEvent.INITIATED, payment.id, { amount: 100 })),
      );

      // Verify all states
      const updatedOrder = await firstValueFrom(orderEntityService.load(order.id));
      const updatedUser = await firstValueFrom(userEntityService.load(user.id));
      const updatedPayment = await firstValueFrom(paymentEntityService.load(payment.id));

      assertEntityState(updatedOrder!, orderEntityService, OrderState.PROCESSING);
      assertEntityState(updatedUser!, userEntityService, OnboardingState.EMAIL_VERIFICATION);
      assertEntityState(updatedPayment!, paymentEntityService, PaymentState.AUTHORIZING);
    });
  });

  describe('Entity Service Isolation', () => {
    test('should maintain separate entity stores for different workflows', async () => {
      const order = await firstValueFrom(orderEntityService.create());
      const user = await firstValueFrom(userEntityService.create());
      const payment = await firstValueFrom(paymentEntityService.create());

      // Verify entities are in separate stores
      expect(await firstValueFrom(orderEntityService.load(order.id))).toBeDefined();
      expect(await firstValueFrom(userEntityService.load(user.id))).toBeDefined();
      expect(await firstValueFrom(paymentEntityService.load(payment.id))).toBeDefined();

      // Verify cross-store access fails
      expect(await firstValueFrom(orderEntityService.load(user.id))).toBeNull();
      expect(await firstValueFrom(userEntityService.load(order.id))).toBeNull();
      expect(await firstValueFrom(paymentEntityService.load(order.id))).toBeNull();
    });
  });

  describe('Concurrent Workflow Execution', () => {
    test('should handle concurrent transitions across different workflows', async () => {
      const order = await firstValueFrom(orderEntityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 100 }];
      await firstValueFrom(orderEntityService.update(order, OrderState.PENDING));

      const user = await firstValueFrom(userEntityService.create());
      await firstValueFrom(userEntityService.update(user, OnboardingState.REGISTRATION));

      // Execute transitions concurrently
      await Promise.all([
        firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true }))),
        firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.REGISTERED, user.id))),
      ]);

      // Verify both workflows progressed
      const updatedOrder = await firstValueFrom(orderEntityService.load(order.id));
      const updatedUser = await firstValueFrom(userEntityService.load(user.id));

      assertEntityState(updatedOrder!, orderEntityService, OrderState.PROCESSING);
      assertEntityState(updatedUser!, userEntityService, OnboardingState.EMAIL_VERIFICATION);
    });
  });

  describe('Error Isolation', () => {
    test('should isolate errors between different workflows', async () => {
      const order = await firstValueFrom(orderEntityService.create());
      order.items = []; // Empty items will cause error
      await firstValueFrom(orderEntityService.update(order, OrderState.PENDING));

      const user = await firstValueFrom(userEntityService.create());
      await firstValueFrom(userEntityService.update(user, OnboardingState.REGISTRATION));

      // Order workflow should fail
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));
      const failedOrder = await firstValueFrom(orderEntityService.load(order.id));
      assertEntityState(failedOrder!, orderEntityService, OrderState.FAILED);

      // User workflow should still work
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.REGISTERED, user.id)));
      const updatedUser = await firstValueFrom(userEntityService.load(user.id));
      assertEntityState(updatedUser!, userEntityService, OnboardingState.EMAIL_VERIFICATION);
    });
  });

  describe('Workflow Routing', () => {
    test('should route events to correct workflows based on topic', async () => {
      const order = await firstValueFrom(orderEntityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 100 }];
      await firstValueFrom(orderEntityService.update(order, OrderState.PENDING));

      const user = await firstValueFrom(userEntityService.create());
      await firstValueFrom(userEntityService.update(user, OnboardingState.REGISTRATION));

      // Order event should only affect order workflow
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));

      // User event should only affect user workflow
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OnboardingEvent.REGISTERED, user.id)));

      // Verify correct workflows were affected
      const updatedOrder = await firstValueFrom(orderEntityService.load(order.id));
      const updatedUser = await firstValueFrom(userEntityService.load(user.id));

      assertEntityState(updatedOrder!, orderEntityService, OrderState.PROCESSING);
      assertEntityState(updatedUser!, userEntityService, OnboardingState.EMAIL_VERIFICATION);
    });

    test('should throw error for unknown event topic', async () => {
      await expect(
        firstValueFrom(orchestrator.transit(createWorkflowEvent('unknown.event' as any, 'test-id'))),
      ).rejects.toThrow();
    });
  });
});
