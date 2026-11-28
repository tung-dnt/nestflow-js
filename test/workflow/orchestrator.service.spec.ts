import { firstValueFrom, type Observable, defer, of, map, throwError } from 'rxjs';
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
  WORKFLOW_HISTORY,
  WORKFLOW_TELEMETRY,
  type IWorkflowDefinition,
  type IWorkflowEvent,
  type PayloadValidator,
  type TransitionLog,
  type TransitionTrace,
  type WorkflowTelemetry,
  type WorkflowHistory,
} from '@/core';
import { UnretriableException, WorkflowCancelledException } from '@/exception';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, test, vi } from 'vite-plus/test';
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
    telemetry,
    history,
    historyOptions,
  }: {
    transitions?: Definition['transitions'];
    idles?: Definition['states']['idles'];
    conditions?: Definition['conditions'];
    payloadValidator?: PayloadValidator;
    handle?: (eventId: string) => Promise<unknown>;
    beforeCommit?: (state: State) => void;
    telemetry?: WorkflowTelemetry;
    history?: WorkflowHistory;
    historyOptions?: Definition['history'];
  } = {}) {
    const event = createWorkflowEvent(eventName, orderUrn);
    class OrderStore extends InMemoryWorkflowEntity<Entity, 'state'> {
      create(id: string = orderUrn): Observable<Entity> {
        return defer(() => of(this.save({ id, state: 'pending' })));
      }
    }
    const store = new OrderStore('state', beforeCommit);
    await firstValueFrom(store.create());

    @Workflow<Entity, string, State>({
      name: 'OrderWorkflow',
      entityService: 'test.orders',
      states: { finals: ['done', 'failed'], idles, failed: 'failed' },
      transitions,
      conditions,
      history: historyOptions,
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
            providers: [
              ...(telemetry ? [{ provide: WORKFLOW_TELEMETRY, useValue: telemetry }] : []),
              ...(history ? [{ provide: WORKFLOW_HISTORY, useValue: history }] : []),
            ],
          }),
        ],
      }).compile();
      modules.add(app);
      return { app, orchestrator: app.get(OrchestratorService) };
    }

    return { ...(await createContext()), createContext, event, store };
  }

  describe('OrchestratorService', () => {
    test('runs on subscription and reuses the committed receipt on resubscription', async () => {
      let effects = 0;
      const { app, event, orchestrator, store } = await createWorkflow({
        handle: async () => ++effects,
      });
      await app.init();

      const attempt = orchestrator.transit(event);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('pending');
      expect(effects).toBe(0);
      expect(await firstValueFrom(attempt)).toEqual({ status: 'final', state: 'done' });
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('done');
      expect(await firstValueFrom(attempt)).toEqual({ status: 'final', state: 'done' });
      expect(effects).toBe(1);
    });

    test('unsubscribing stops delivery but lets a claimed attempt finish', async () => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const { app, event, orchestrator, store } = await createWorkflow({
        handle: async () => {
          started.resolve();
          await finish.promise;
        },
        telemetry: { log: () => {}, trace: () => completed.resolve() },
      });
      await app.init();

      const observer = { next: vi.fn(), error: vi.fn(), complete: vi.fn() };
      const subscription = orchestrator.transit(event).subscribe(observer);
      await started.promise;
      subscription.unsubscribe();
      finish.resolve();
      await completed.promise;

      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('done');
      expect(observer.next).not.toHaveBeenCalled();
      expect(observer.error).not.toHaveBeenCalled();
      expect(observer.complete).not.toHaveBeenCalled();
    });

    test('blocks new claims and continuation but lets an already claimed handler commit', async () => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const { app, orchestrator, event, store } = await createWorkflow({
        transitions: [advance('pending', 'review'), advance('review', 'done')],
        handle: async () => {
          started.resolve();
          await finish.promise;
        },
      });
      await app.init();
      const attempted = expect(firstValueFrom(orchestrator.transit(event))).rejects.toBeInstanceOf(
        WorkflowCancelledException,
      );
      await started.promise;
      try {
        expect(await firstValueFrom(orchestrator.requestCancellation(event.event, event.urn))).toBe(true);
        expect(await firstValueFrom(orchestrator.requestCancellation(event.event, event.urn))).toBe(true);
        await expect(
          firstValueFrom(orchestrator.transit(createWorkflowEvent(event.event, event.urn))),
        ).rejects.toBeInstanceOf(WorkflowCancelledException);
      } finally {
        finish.resolve();
      }
      await attempted;
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('review');
    });

    test.each([false, true])('records each committed entry until the host accepts it, payload: %s', async (payload) => {
      let handlerCalls = 0;
      const record = vi
        .fn<NonNullable<WorkflowHistory['record']>>()
        .mockReturnValueOnce(throwError(() => new Error('History store unavailable')))
        .mockReturnValue(of(undefined));
      const { app, event, orchestrator } = await createWorkflow({
        history: { record, list: () => of({ entries: [] }) },
        historyOptions: { payload },
        handle: async () => {
          handlerCalls++;
        },
      });
      await app.init();
      const input = { ...event, payload: { note: 'kept only on opt-in' } };

      await expect(firstValueFrom(orchestrator.transit(input))).rejects.toThrow('History store unavailable');
      const redelivered = await firstValueFrom(orchestrator.transit(input));

      const entry = record.mock.calls[0]?.[0];
      expect(entry).toMatchObject({ event: eventName, eventId: event.eventId, from: 'pending', to: 'done' });
      expect(entry?.outcome).toBe('applied');
      expect(entry?.payload).toEqual(payload ? input.payload : undefined);
      expect(record).toHaveBeenLastCalledWith(entry);
      expect(redelivered).toEqual({ status: 'final', state: 'done', history: entry });
      expect(handlerCalls).toBe(1);
    });

    test('records the handler failure that moved the entity to the failed state', async () => {
      const record = vi.fn<NonNullable<WorkflowHistory['record']>>().mockReturnValue(of(undefined));
      const { app, event, orchestrator } = await createWorkflow({
        history: { record, list: () => of({ entries: [] }) },
        handle: async () => {
          throw new UnretriableException('Card declined');
        },
      });
      await app.init();

      expect(await firstValueFrom(orchestrator.transit(event))).toMatchObject({ status: 'final', state: 'failed' });
      expect(record).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          to: 'failed',
          outcome: 'unretriable',
          error: expect.objectContaining({ message: 'Card declined' }),
        }),
      );
    });

    test('reports a commit and a receipt replay as distinct facts', async () => {
      const logs: TransitionLog[] = [];
      const traces: TransitionTrace[] = [];
      const { app, event, orchestrator } = await createWorkflow({
        telemetry: {
          log: (entry) => {
            logs.push(entry);
          },
          trace: (entry) => {
            traces.push(entry);
          },
        },
      });
      await app.init();
      const input = { ...event, payload: { note: 'private-telemetry-payload' } };

      await firstValueFrom(orchestrator.transit(input));
      await firstValueFrom(orchestrator.transit(input));

      expect(logs).toEqual([
        {
          kind: 'transition_committed',
          workflow: 'OrderWorkflow',
          event: eventName,
          attempt: 0,
          from: 'pending',
          to: 'done',
          outcome: 'applied',
        },
        { kind: 'receipt_replayed', workflow: 'OrderWorkflow', event: eventName, attempt: 0, outcome: 'applied' },
      ]);
      expect(traces.map((trace) => trace.outcome)).toEqual(['final', 'final']);
      expect(JSON.stringify(traces)).not.toContain('private-telemetry-payload');
    });

    test('preserves the handler error when telemetry throws or rejects', async () => {
      const failure = new Error('Handler failed');
      const { app, event, orchestrator, store } = await createWorkflow({
        handle: async () => {
          throw failure;
        },
        telemetry: {
          log: () => {
            throw new Error('Logger unavailable');
          },
          trace: async () => {
            throw new Error('Tracer unavailable');
          },
        },
      });
      await app.init();

      await expect(firstValueFrom(orchestrator.transit(event))).rejects.toBe(failure);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('failed');
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

      await expect(firstValueFrom(orchestrator.transit({ ...event, payload: {} }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(handlerCalls).toBe(0);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('pending');
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

      await expect(firstValueFrom(orchestrator.transit(event))).rejects.toBe(ruleError);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('review');

      const replay = await createContext();
      await replay.app.init();
      const result = await firstValueFrom(replay.orchestrator.transit({ ...event }));
      if (result.status !== 'continued') throw new Error(`Expected continuation, got ${result.status}`);
      expect(result.nextEvent).toMatchObject({ event: event.event, urn: event.urn, payload: output, attempt: 0 });
      expect(result.nextEvent.eventId).not.toBe(event.eventId);
      expect(effects).toBe(1);

      await expect(firstValueFrom(replay.orchestrator.transit(result.nextEvent))).resolves.toEqual({
        status: 'final',
        state: 'done',
      });
      expect(await firstValueFrom(replay.orchestrator.transit({ ...event }))).toEqual(result);
      expect(effects).toBe(2);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('done');
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
        await firstValueFrom(orchestrator.transit(event));
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

      await expect(firstValueFrom(orchestrator.transit(event))).rejects.toBeInstanceOf(BadRequestException);
      expect(handlerCalls).toBe(0);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('pending');
    });

    test('accepts zero as a numeric idle state', async () => {
      const { app, event, orchestrator, store } = await createWorkflow({
        transitions: [advance('pending', 0)],
        idles: [0],
      });
      await app.init();

      expect(await firstValueFrom(orchestrator.transit(event))).toMatchObject({ status: 'idle', state: 0 });
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe(0);
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

      const first = firstValueFrom(orchestrator.transit(event));
      await started.promise;
      const deliveries = Promise.allSettled([first, firstValueFrom(peer.orchestrator.transit({ ...event }))]);
      await setImmediate();
      release.resolve();

      const [original, duplicate] = await deliveries;
      expect(original.status).toBe('fulfilled');
      expect(duplicate).toEqual({ status: 'rejected', reason: expect.any(ConflictException) });
      expect(effects).toBe(1);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('done');
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
      expect(await firstValueFrom(orchestrator.transit(event))).toMatchObject(result);
      expect(await firstValueFrom(orchestrator.transit({ ...event }))).toMatchObject(result);
      expect(effects).toBe(1);

      expect(await firstValueFrom(orchestrator.transit(createWorkflowEvent(event.event, event.urn)))).toMatchObject(
        result,
      );
      expect(effects).toBe(2);
    });

    test('does not expose event payload values in logs', async () => {
      const { app, event, orchestrator } = await createWorkflow();
      await app.init();
      const log = vi.spyOn(Logger.prototype, 'log');
      const payloadMarker = 'private-order-details-test-marker';

      try {
        await firstValueFrom(orchestrator.transit({ ...event, payload: { privateNote: payloadMarker } }));
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
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('done');
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
      vi.spyOn(store, 'claimTransition').mockImplementation((urn, eventId) =>
        claimTransition(urn, eventId).pipe(
          map((claim) => {
            if (claim.kind !== 'acquired') return claim;
            return {
              ...claim,
              release: () => throwError(() => storageError),
            };
          }),
        ),
      );
      await app.init();
      const run = DurableLambdaEventHandler(app, mockWithDurableExecution);

      await expect(run(durableInput(event), new MockDurableContext())).rejects.toMatchObject({
        cause: handlerError,
        errors: [handlerError, storageError],
      });
      expect(attempts).toBe(1);
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('pending');
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
      expect((await firstValueFrom(store.load(event.urn)))?.state).toBe('failed');
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
      const second = await firstValueFrom(store.create('order-b'));
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
