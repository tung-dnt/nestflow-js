import { firstValueFrom } from 'rxjs';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';
import { WorkflowModule } from '@/core/workflow.module';
import { OrchestratorService } from '@/core/providers/orchestrator.service';
import { assertEntityState, createWorkflowEvent } from '../../fixtures/test-helpers';
import { OrderWorkflow, OrderEvent, ORDER_ENTITY_TOKEN } from './order.workflow';
import { OrderEntityService, OrderState } from './order.entity';

describe('Order Processing Workflow E2E', () => {
  let module: TestingModule;
  let orchestrator: OrchestratorService;
  let entityService: OrderEntityService;

  beforeEach(async () => {
    entityService = new OrderEntityService();

    module = await Test.createTestingModule({
      imports: [
        WorkflowModule.register({
          entities: [{ provide: ORDER_ENTITY_TOKEN, useValue: entityService }],
          workflows: [OrderWorkflow],
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

  describe('Happy Path', () => {
    test('should complete order workflow: PENDING → PROCESSING → SHIPPED', async () => {
      // Create order
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 2, price: 100 }];
      order.totalAmount = 200;
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      // Approve and process
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));
      let updatedOrder = await firstValueFrom(entityService.load(order.id));
      expect(updatedOrder).toBeDefined();
      assertEntityState(updatedOrder!, entityService, OrderState.PROCESSING);

      // Ship order
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.PROCESSING, order.id)));
      updatedOrder = await firstValueFrom(entityService.load(order.id));
      expect(updatedOrder).toBeDefined();
      assertEntityState(updatedOrder!, entityService, OrderState.SHIPPED);
    });
  });

  describe('Conditional Transitions', () => {
    test('should wait in PENDING when approval condition not met', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      // Try to transition without approval
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: false })),
      );

      // Order should still be in PENDING (idle state, condition not met)
      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.PENDING);
    });

    test('should transition when approval condition is met', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      // Transition with approval
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.PROCESSING);
    });

    test('should prevent cancellation of shipped order', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.SHIPPED));

      // Try to cancel shipped order (should fail due to condition)
      await expect(
        firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CANCELLED, order.id))),
      ).rejects.toThrow();

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.SHIPPED);
    });
  });

  describe('Cancellation Flow', () => {
    test('should cancel order from PENDING state', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CANCELLED, order.id)));

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.CANCELLED);
    });

    test('should cancel order from PROCESSING state', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PROCESSING));

      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CANCELLED, order.id)));

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.CANCELLED);
    });
  });

  describe('Error Handling', () => {
    test('should transition to FAILED when handler throws error', async () => {
      const order = await firstValueFrom(entityService.create());
      // Order with no items should fail validation
      order.items = [];
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      await expect(
        firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true }))),
      ).resolves.toEqual({ status: 'final', state: OrderState.FAILED });

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.FAILED);
    });

    test('should throw error for invalid transition', async () => {
      const order = await firstValueFrom(entityService.create());
      await firstValueFrom(entityService.update(order, OrderState.SHIPPED));

      // Try to transition from final state
      await expect(
        firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true }))),
      ).rejects.toThrow();
    });

    test('should throw error when entity not found', async () => {
      await expect(
        firstValueFrom(
          orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, 'non-existent-order', { approved: true })),
        ),
      ).rejects.toThrow();
    });
  });

  describe('Idle State Behavior', () => {
    test('should wait in idle state when condition not met', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PENDING));

      // Event without approval
      await firstValueFrom(
        orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: false })),
      );

      // Should still be in PENDING (idle)
      let updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.PENDING);

      // Now with approval
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.CREATED, order.id, { approved: true })));

      // Should transition to PROCESSING
      updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.PROCESSING);
    });
  });

  describe('Automatic Transitions', () => {
    test('should automatically transition from PROCESSING to SHIPPED', async () => {
      const order = await firstValueFrom(entityService.create());
      order.items = [{ name: 'Product 1', quantity: 1, price: 50 }];
      await firstValueFrom(entityService.update(order, OrderState.PROCESSING));

      // PROCESSING event should automatically transition to SHIPPED
      await firstValueFrom(orchestrator.transit(createWorkflowEvent(OrderEvent.PROCESSING, order.id)));

      const updatedOrder = await firstValueFrom(entityService.load(order.id));
      assertEntityState(updatedOrder!, entityService, OrderState.SHIPPED);
    });
  });
});
