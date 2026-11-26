import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vite-plus/test';
import { Test } from '@nestjs/testing';
import { withDurableExecution, type DurableLambdaHandler } from '@aws/durable-execution-sdk-js';
import { LocalDurableTestRunner, WaitingOperationStatus } from '@aws/durable-execution-sdk-js-testing';
import { EventId, OnEvent, RetryStrategy, WithRetry, Workflow, WorkflowModule } from '@/core';
import { DurableLambdaEventHandler } from '@/adapter';
import type { DurableWorkflowResult } from '@/adapter';
import { OrderWorkflow, OrderEvent, ORDER_ENTITY_TOKEN } from '../workflows/order-processing/order.workflow';
import { OrderEntityService, OrderState, type Order } from '../workflows/order-processing/order.entity';

describe('Durable Lambda Adapter — Order Workflow E2E', () => {
  let handler: DurableLambdaHandler;
  let entityService: OrderEntityService;
  const retryEvent = 'order.ship-with-retry';
  const attemptedEventIds: string[] = [];

  @Workflow<Order, typeof retryEvent, OrderState>({
    name: 'RetryingOrderWorkflow',
    entityService: ORDER_ENTITY_TOKEN,
    states: { finals: [OrderState.SHIPPED], idles: [], failed: OrderState.FAILED },
    transitions: [{ event: retryEvent, from: [OrderState.PENDING], to: OrderState.SHIPPED }],
  })
  class RetryingOrderWorkflow {
    @OnEvent(retryEvent)
    @WithRetry({ handler: 'ship', maxAttempts: 3, strategy: RetryStrategy.FIXED, initialDelay: 1000 })
    async ship(@EventId() eventId: string) {
      attemptedEventIds.push(eventId);
      throw new Error('Shipping service unavailable');
    }
  }

  beforeAll(async () => {
    await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });

    const module = await Test.createTestingModule({
      imports: [
        WorkflowModule.register({
          entities: [{ provide: ORDER_ENTITY_TOKEN, useValue: new OrderEntityService() }],
          workflows: [OrderWorkflow, RetryingOrderWorkflow],
        }),
      ],
    }).compile();

    const app = module.createNestApplication();
    await app.init();

    entityService = module.get<OrderEntityService>(ORDER_ENTITY_TOKEN);
    handler = DurableLambdaEventHandler(app, withDurableExecution);
  });

  afterAll(async () => {
    await LocalDurableTestRunner.teardownTestEnvironment();
  });

  beforeEach(() => {
    entityService.clear();
    attemptedEventIds.length = 0;
  });

  describe('Happy Path', () => {
    test('should process order PENDING → PROCESSING → SHIPPED with callback between steps', async () => {
      const order = await entityService.create();
      order.items = [{ name: 'Widget', quantity: 1, price: 10 }];
      order.totalAmount = 10;
      await entityService.update(order, OrderState.PENDING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      // Get the callback operation reference before running
      const awaitingCallback = runner.getOperation(`awaiting:${OrderState.PROCESSING}:0`);

      const executionPromise = runner.run({
        payload: {
          urn: order.id,
          eventId: `${order.id}:created`,
          initialEvent: OrderEvent.CREATED,
          payload: { approved: true },
        },
      });

      // Wait for the callback submitter to complete, then send the event
      await awaitingCallback.waitForData(WaitingOperationStatus.SUBMITTED);
      await awaitingCallback.sendCallbackSuccess(JSON.stringify({ event: OrderEvent.PROCESSING, payload: {} }));

      const execution = await executionPromise;

      expect(execution.getStatus()).toBe('SUCCEEDED');
      expect(execution.getResult()).toEqual({
        urn: order.id,
        status: 'completed',
        state: OrderState.SHIPPED,
      });

      const updatedOrder = await entityService.load(order.id);
      expect(entityService.status(updatedOrder!)).toBe(OrderState.SHIPPED);
    });
  });

  describe('Idle State — Callback Wait', () => {
    test('should wait at idle state and resume on callback', async () => {
      const order = await entityService.create();
      order.items = [{ name: 'Widget', quantity: 1, price: 10 }];
      order.totalAmount = 10;
      await entityService.update(order, OrderState.PENDING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      // First callback: idle at PENDING (conditions not met)
      const idleCallback = runner.getOperation(`idle:${OrderState.PENDING}:0`);
      // Second callback: awaiting at PROCESSING (ambiguous auto-transition)
      const awaitingCallback = runner.getOperation(`awaiting:${OrderState.PROCESSING}:1`);

      const executionPromise = runner.run({
        payload: {
          urn: order.id,
          eventId: `${order.id}:created`,
          initialEvent: OrderEvent.CREATED,
          payload: { approved: false },
        },
      });

      // Idle state: conditions not met, submit with approved: true
      await idleCallback.waitForData(WaitingOperationStatus.SUBMITTED);
      await idleCallback.sendCallbackSuccess(
        JSON.stringify({ event: OrderEvent.CREATED, payload: { approved: true } }),
      );

      // Now PENDING → PROCESSING → awaiting callback (ambiguous auto-transition)
      await awaitingCallback.waitForData(WaitingOperationStatus.SUBMITTED);
      await awaitingCallback.sendCallbackSuccess(JSON.stringify({ event: OrderEvent.PROCESSING, payload: {} }));

      const execution = await executionPromise;

      expect(execution.getStatus()).toBe('SUCCEEDED');
      expect(execution.getResult()).toEqual({
        urn: order.id,
        status: 'completed',
        state: OrderState.SHIPPED,
      });
    });

    test('keeps distinct callbacks separate when two executions receive the same initial delivery', async () => {
      const order = await entityService.create();
      order.items = [{ name: 'Widget', quantity: 1, price: 10 }];
      await entityService.update(order, OrderState.PENDING);
      const delivery = {
        payload: {
          urn: order.id,
          eventId: `${order.id}:created`,
          initialEvent: OrderEvent.CREATED,
          payload: { approved: true },
        },
      };
      const first = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });
      const second = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });
      const firstCallback = first.getOperation(`awaiting:${OrderState.PROCESSING}:0`);
      const secondCallback = second.getOperation(`awaiting:${OrderState.PROCESSING}:0`);

      const firstRun = first.run(delivery);
      await firstCallback.waitForData(WaitingOperationStatus.SUBMITTED);
      const secondRun = second.run(delivery);
      await secondCallback.waitForData(WaitingOperationStatus.SUBMITTED);

      await firstCallback.sendCallbackSuccess(JSON.stringify({ event: OrderEvent.PROCESSING }));
      expect((await firstRun).getResult()).toMatchObject({ state: OrderState.SHIPPED });
      await secondCallback.sendCallbackSuccess(JSON.stringify({ event: OrderEvent.CANCELLED }));
      expect((await secondRun).getStatus()).toBe('FAILED');
      expect(await entityService.load(order.id)).toMatchObject({ status: OrderState.SHIPPED });
    });
  });

  describe('Error Handling', () => {
    test('should return completed with FAILED state on unretriable error', async () => {
      const order = await entityService.create();
      order.items = [];
      order.totalAmount = 0;
      await entityService.update(order, OrderState.PENDING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      const execution = await runner.run({
        payload: {
          urn: order.id,
          eventId: `${order.id}:created`,
          initialEvent: OrderEvent.CREATED,
          payload: { approved: true },
        },
      });

      expect(execution.getStatus()).toBe('SUCCEEDED');
      expect(execution.getResult()).toEqual({
        urn: order.id,
        status: 'completed',
        state: OrderState.FAILED,
      });

      const updatedOrder = await entityService.load(order.id);
      expect(entityService.status(updatedOrder!)).toBe(OrderState.FAILED);
    });

    test('should fail for event with no route', async () => {
      const order = await entityService.create();
      await entityService.update(order, OrderState.PROCESSING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      const execution = await runner.run({
        payload: { urn: order.id, eventId: `${order.id}:invalid`, initialEvent: 'nonexistent.event', payload: {} },
      });

      expect(execution.getStatus()).toBe('FAILED');
    });

    test('should use only the configured retry budget with the AWS SDK', async () => {
      const order = await entityService.create();
      const eventId = `${order.id}:ship`;
      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      const execution = await runner.run({ payload: { urn: order.id, eventId, initialEvent: retryEvent } });

      expect(execution.getStatus()).toBe('FAILED');
      expect(await entityService.load(order.id)).toMatchObject({ status: OrderState.FAILED });
      expect(attemptedEventIds).toEqual([eventId, eventId, eventId]);
      expect(execution.getOperations().filter((operation) => operation.getType() === 'WAIT')).toHaveLength(2);
      expect(
        execution
          .getHistoryEvents()
          .some((event) => event.StepFailedDetails?.RetryDetails?.NextAttemptDelaySeconds !== undefined),
      ).toBe(false);
    });

    test('preserves the handler diagnostic when AWS serializes a claim release failure', async () => {
      const order = await entityService.create();
      const eventId = `${order.id}:ship`;
      const claimTransition = entityService.claimTransition.bind(entityService);
      const claimSpy = vi.spyOn(entityService, 'claimTransition').mockImplementation(async (urn, id) => {
        const claim = await claimTransition(urn, id);
        if (claim.kind !== 'acquired') return claim;
        return {
          ...claim,
          release: async () => {
            throw new Error('Claim store unavailable');
          },
        };
      });

      try {
        const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });
        const execution = await runner.run({ payload: { urn: order.id, eventId, initialEvent: retryEvent } });

        expect(execution.getStatus()).toBe('FAILED');
        expect(execution.getError().errorMessage).toContain('Shipping service unavailable');
        expect(attemptedEventIds).toEqual([eventId]);
        expect(await entityService.load(order.id)).toMatchObject({ status: OrderState.PENDING });
      } finally {
        claimSpy.mockRestore();
      }
    });
  });

  describe('Cancellation', () => {
    test('should cancel order from PENDING state', async () => {
      const order = await entityService.create();
      order.items = [{ name: 'Widget', quantity: 1, price: 10 }];
      await entityService.update(order, OrderState.PENDING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      const execution = await runner.run({
        payload: {
          urn: order.id,
          eventId: `${order.id}:cancelled`,
          initialEvent: OrderEvent.CANCELLED,
          payload: {},
        },
      });

      expect(execution.getStatus()).toBe('SUCCEEDED');
      expect(execution.getResult()).toEqual({
        urn: order.id,
        status: 'completed',
        state: OrderState.CANCELLED,
      });
    });
  });

  describe('Operation Inspection', () => {
    test('should checkpoint each transit step', async () => {
      const order = await entityService.create();
      order.items = [{ name: 'Widget', quantity: 1, price: 10 }];
      await entityService.update(order, OrderState.PENDING);

      const runner = new LocalDurableTestRunner<DurableWorkflowResult>({ handlerFunction: handler });

      const awaitingCallback = runner.getOperation(`awaiting:${OrderState.PROCESSING}:0`);

      const executionPromise = runner.run({
        payload: {
          urn: order.id,
          eventId: `${order.id}:created`,
          initialEvent: OrderEvent.CREATED,
          payload: { approved: true },
        },
      });

      await awaitingCallback.waitForData(WaitingOperationStatus.SUBMITTED);
      await awaitingCallback.sendCallbackSuccess(JSON.stringify({ event: OrderEvent.PROCESSING, payload: {} }));

      const execution = await executionPromise;

      // Verify step operations were checkpointed
      const transitStep = runner.getOperation(`transit:${OrderEvent.CREATED}:0:0`);
      const stepDetails = await transitStep.waitForData(WaitingOperationStatus.COMPLETED);
      expect(stepDetails.getStepDetails()?.result).toBeDefined();

      expect(execution.getOperations().length).toBeGreaterThanOrEqual(3);
    });
  });
});
