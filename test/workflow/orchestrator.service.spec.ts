import { DurableLambdaEventHandler, type DurableWorkflowEvent } from '@/adapter';
import {
  EventId,
  OnEvent,
  OrchestratorService,
  Payload,
  RetryStrategy,
  WithRetry,
  Workflow,
  WorkflowModule,
  type IWorkflowDefinition,
  type IWorkflowEvent,
  type PayloadValidator,
} from '@/core';
import { UnretriableException } from '@/exception';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { InMemoryWorkflowEntity } from '../e2e/fixtures/in-memory-workflow-entity';
import { MockDurableContext, mockWithDurableExecution } from '../e2e/fixtures/mock-durable-context';
import { createWorkflowEvent } from '../e2e/fixtures/test-helpers';

type State = 'pending' | 'review' | 'done' | 'failed' | 0;
type Entity = { id: string; state: State };
type Definition = IWorkflowDefinition<Entity, string, State>;

const orderUrn = 'order-a';
const eventName = 'order.advance';
const advance = (from: State, to: State) => ({ from: [from], to, event: eventName });

function durableInput({ urn, event, eventId }: IWorkflowEvent<unknown>): DurableWorkflowEvent {
  return { urn, initialEvent: event, eventId };
}

describe('Workflow transition regressions', () => {
  const modules = new Set<TestingModule>();

  afterEach(async () => {
    const open = [...modules];
    modules.clear();
    await Promise.all(open.map((app) => app.close()));
  });

  async function createWorkflow({
    transitions = [advance('pending', 'done')],
    idles = [],
    conditions,
    payloadValidator,
    handle = async () => {},
    beforeCommit,
  }: {
    transitions?: Definition['transitions'];
    idles?: Definition['states']['idles'];
    conditions?: Definition['conditions'];
    payloadValidator?: PayloadValidator;
    handle?: (eventId: string) => Promise<unknown>;
    beforeCommit?: (state: State) => void;
  } = {}) {
    const event = createWorkflowEvent(eventName, orderUrn);
    class OrderStore extends InMemoryWorkflowEntity<Entity, 'state'> {
      async create(id: string = orderUrn): Promise<Entity> {
        return this.save({ id, state: 'pending' });
      }
    }
    const store = new OrderStore('state', beforeCommit);
    await store.create();

    @Workflow<Entity, string, State>({
      name: 'OrderWorkflow',
      entityService: 'test.orders',
      states: { finals: ['done', 'failed'], idles, failed: 'failed' },
      transitions,
      conditions,
    })
    class OrderWorkflow {
      @OnEvent(eventName)
      @WithRetry({ handler: 'advance', maxAttempts: 3, strategy: RetryStrategy.FIXED, initialDelay: 1000 })
      async advance(@Payload({}) _payload: unknown, @EventId() deliveryId: string) {
        return handle(deliveryId);
      }
    }

    async function createContext() {
      const app = await Test.createTestingModule({
        imports: [
          WorkflowModule.register({
            entities: [{ provide: 'test.orders', useValue: store }],
            workflows: [OrderWorkflow],
            payloadValidator,
          }),
        ],
      }).compile();
      modules.add(app);
      return { app, orchestrator: app.get(OrchestratorService) };
    }

    return { ...(await createContext()), createContext, event, store };
  }

  describe('OrchestratorService', () => {
    test('commits a valid transition and returns the terminal state', async () => {
      const { app, event, orchestrator, store } = await createWorkflow();
      await app.init();

      expect(await orchestrator.transit(event)).toEqual({ status: 'final', state: 'done' });
      expect((await store.load(event.urn))?.state).toBe('done');
    });

    test('rejects invalid payloads without running the handler or changing the state', async () => {
      let handlerCalls = 0;
      const { app, event, orchestrator, store } = await createWorkflow({
        payloadValidator: () => {
          throw new Error('Missing approval');
        },
        handle: async () => {
          handlerCalls++;
        },
      });
      await app.init();

      await expect(orchestrator.transit({ ...event, payload: {} })).rejects.toBeInstanceOf(BadRequestException);
      expect(handlerCalls).toBe(0);
      expect((await store.load(event.urn))?.state).toBe('pending');
    });

    test('replays a committed transition after evaluating the next transition fails', async () => {
      const ruleError = new Error('Cannot evaluate review rule');
      const output = 'review-approved';
      let failNextCheck = true;
      let effects = 0;
      const { app, createContext, event, orchestrator, store } = await createWorkflow({
        transitions: [
          advance('pending', 'review'),
          {
            ...advance('review', 'done'),
            conditions: [
              (_entity, payload) => {
                if (failNextCheck) {
                  failNextCheck = false;
                  throw ruleError;
                }
                return payload === output;
              },
            ],
          },
        ],
        handle: async () => {
          effects++;
          return output;
        },
      });
      await app.init();

      await expect(orchestrator.transit(event)).rejects.toBe(ruleError);
      expect((await store.load(event.urn))?.state).toBe('review');

      const replay = await createContext();
      await replay.app.init();
      const result = await replay.orchestrator.transit({ ...event });
      if (result.status !== 'continued') throw new Error(`Expected continuation, got ${result.status}`);
      expect(result.nextEvent).toMatchObject({ event: event.event, urn: event.urn, payload: output, attempt: 0 });
      expect(result.nextEvent.eventId).not.toBe(event.eventId);
      expect(effects).toBe(1);

      await expect(replay.orchestrator.transit(result.nextEvent)).resolves.toEqual({ status: 'final', state: 'done' });
      expect(await replay.orchestrator.transit({ ...event })).toEqual(result);
      expect(effects).toBe(2);
      expect((await store.load(event.urn))?.state).toBe('done');
    });

    test('preserves the handler error when recording permanent failure also fails', async () => {
      const handlerError = new UnretriableException('Order declined');
      const { app, event, orchestrator } = await createWorkflow({
        handle: async () => {
          throw handlerError;
        },
        beforeCommit: (state) => {
          if (state === 'failed') throw new Error('Storage unavailable');
        },
      });
      await app.init();

      try {
        await orchestrator.transit(event);
      } catch (error) {
        expect(
          error === handlerError ||
            (error instanceof Error && error.cause === handlerError) ||
            (error instanceof AggregateError && error.errors.includes(handlerError)),
        ).toBe(true);
        return;
      }
      throw new Error('A permanent failure that could not be recorded must be reported');
    });

    test('blocks a transition when a workflow-level guard returns false', async () => {
      let handlerCalls = 0;
      const { app, event, orchestrator, store } = await createWorkflow({
        conditions: [() => false],
        handle: async () => {
          handlerCalls++;
        },
      });
      await app.init();

      await expect(orchestrator.transit(event)).rejects.toBeInstanceOf(BadRequestException);
      expect(handlerCalls).toBe(0);
      expect((await store.load(event.urn))?.state).toBe('pending');
    });

    test('accepts zero as a numeric idle state', async () => {
      const { app, event, orchestrator, store } = await createWorkflow({
        transitions: [advance('pending', 0)],
        idles: [0],
      });
      await app.init();

      expect(await orchestrator.transit(event)).toMatchObject({ status: 'idle', state: 0 });
      expect((await store.load(event.urn))?.state).toBe(0);
    });

    test('rejects a workflow at startup when a reachable event has no handler', async () => {
      const { app } = await createWorkflow({
        transitions: [advance('pending', 'review'), { ...advance('review', 'done'), event: 'order.finish' }],
      });

      const init = app.init().catch((error: unknown) => {
        modules.delete(app);
        throw error;
      });
      await expect(init).rejects.toThrow(/order\.finish/);
    });

    test('does not run the same business action twice for overlapping deliveries', async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let effects = 0;
      const { app, createContext, event, orchestrator, store } = await createWorkflow({
        handle: async () => {
          effects++;
          started.resolve();
          await release.promise;
        },
      });
      await app.init();
      const peer = await createContext();
      await peer.app.init();

      const first = orchestrator.transit(event);
      await started.promise;
      const deliveries = Promise.allSettled([first, peer.orchestrator.transit({ ...event })]);
      await setImmediate();
      release.resolve();

      const [original, duplicate] = await deliveries;
      expect(original.status).toBe('fulfilled');
      expect(duplicate).toEqual({ status: 'rejected', reason: expect.any(ConflictException) });
      expect(effects).toBe(1);
      expect((await store.load(event.urn))?.state).toBe('done');
    });

    test('replays a completed self-transition without rerunning its action', async () => {
      let effects = 0;
      const { app, event, orchestrator } = await createWorkflow({
        transitions: [advance('pending', 'pending')],
        idles: ['pending'],
        handle: async () => {
          effects++;
        },
      });
      await app.init();

      const result = { status: 'idle', state: 'pending' };
      expect(await orchestrator.transit(event)).toMatchObject(result);
      expect(await orchestrator.transit({ ...event })).toMatchObject(result);
      expect(effects).toBe(1);

      expect(await orchestrator.transit(createWorkflowEvent(event.event, event.urn))).toMatchObject(result);
      expect(effects).toBe(2);
    });

    test('does not expose event payload values in logs', async () => {
      const { app, event, orchestrator } = await createWorkflow();
      await app.init();
      const log = spyOn(Logger.prototype, 'log');
      const payloadMarker = 'private-order-details-test-marker';

      try {
        await orchestrator.transit({ ...event, payload: { privateNote: payloadMarker } });
        expect(JSON.stringify(log.mock.calls)).not.toContain(payloadMarker);
      } finally {
        log.mockRestore();
      }
    });
  });

  describe('DurableLambdaEventHandler', () => {
    test('retries a transient handler failure from its original state', async () => {
      const seenEventIds: string[] = [];
      const { app, event, store } = await createWorkflow({
        handle: async (deliveryId) => {
          seenEventIds.push(deliveryId);
          if (seenEventIds.length === 1) throw new Error('Temporary gateway failure');
        },
      });
      await app.init();
      const run = DurableLambdaEventHandler(app, mockWithDurableExecution);

      await expect(run(durableInput(event), new MockDurableContext())).resolves.toMatchObject({ state: 'done' });
      expect(seenEventIds).toEqual([event.eventId, event.eventId]);
      expect((await store.load(event.urn))?.state).toBe('done');
    });

    test('preserves the handler error and stops retrying if releasing the claim fails', async () => {
      const handlerError = new Error('Temporary gateway failure');
      const storageError = new Error('Could not reach the claim store');
      let attempts = 0;
      const { app, event, store } = await createWorkflow({
        handle: async () => {
          attempts++;
          throw handlerError;
        },
      });
      const claimTransition = store.claimTransition.bind(store);
      spyOn(store, 'claimTransition').mockImplementation(async (urn, eventId) => {
        const claim = await claimTransition(urn, eventId);
        if (claim.kind !== 'acquired') return claim;
        return {
          ...claim,
          release: async () => {
            throw storageError;
          },
        };
      });
      await app.init();
      const run = DurableLambdaEventHandler(app, mockWithDurableExecution);

      await expect(run(durableInput(event), new MockDurableContext())).rejects.toMatchObject({
        cause: handlerError,
        errors: [handlerError, storageError],
      });
      expect(attempts).toBe(1);
      expect((await store.load(event.urn))?.state).toBe('pending');
    });

    test('persists failed only after the configured attempts are exhausted', async () => {
      let handlerCalls = 0;
      const firstError = new Error('Temporary gateway failure');
      const lastError = new Error('Gateway still unavailable');
      const attemptsAtFailure: number[] = [];
      const { app, event, store } = await createWorkflow({
        handle: async () => {
          if (++handlerCalls < 3) throw firstError;
          throw lastError;
        },
        beforeCommit: (state) => {
          if (state === 'failed') attemptsAtFailure.push(handlerCalls);
        },
      });
      await app.init();
      const run = DurableLambdaEventHandler(app, mockWithDurableExecution);

      await expect(run(durableInput(event), new MockDurableContext())).rejects.toBe(lastError);
      expect(attemptsAtFailure).toEqual([3]);
      expect((await store.load(event.urn))?.state).toBe('failed');
    });

    test('keeps the correct entity identity when two executions overlap', async () => {
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { app, event, store } = await createWorkflow({
        handle: async () => {
          started.resolve();
          await release.promise;
        },
      });
      await app.init();
      const second = await store.create('order-b');
      const run = DurableLambdaEventHandler(app, mockWithDurableExecution);

      const firstRun = run(durableInput(event), new MockDurableContext());
      await started.promise;
      const secondRun = run(durableInput(createWorkflowEvent(eventName, second.id)), new MockDurableContext());
      release.resolve();

      const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
      expect(firstResult).toMatchObject({ urn: event.urn, state: 'done' });
      expect(secondResult).toMatchObject({ urn: second.id, state: 'done' });
    });
  });
});
