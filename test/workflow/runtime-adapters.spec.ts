import { InMemoryWorkflowEntity, InvalidWorkflowMessageError, processWorkflowMessage, runInProcess } from '@/adapter';
import {
  Entity,
  EventId,
  OnEvent,
  OrchestratorService,
  Payload,
  RetryStrategy,
  WithRetry,
  Workflow,
  WorkflowModule,
  WORKFLOW_TELEMETRY,
  type IWorkflowEvent,
  type TransitionTrace,
  type WorkflowTelemetry,
} from '@/core';
import { UnretriableException } from '@/exception';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, test } from 'vite-plus/test';

type State = 'pending' | 'review' | 'done' | 'failed';
type Order = { id: string | number; state: State; notes: string[] };

const orders = 'test.runtime.orders';
const finishEvent = 'order.finish';
const submit = { urn: 0, event: 'order.submit', eventId: 'submit-1', payload: { item: 'book' }, attempt: 0 };
const waitTimeout = { minutes: 1 };

class OrderStore extends InMemoryWorkflowEntity<Order, 'state'> {
  constructor() {
    super('state');
  }

  async create(id: Order['id'] = submit.urn): Promise<Order> {
    return this.save({ id, state: 'pending', notes: [] });
  }
}

describe('Workflow runtime adapters', () => {
  const modules: TestingModule[] = [];

  afterEach(async () => {
    await Promise.all(modules.splice(0).map((app) => app.close()));
  });

  async function createWorkflow({
    idle = false,
    canFinish = () => true,
    handleSubmit = (payload) => payload,
  }: {
    idle?: boolean;
    canFinish?: (payload: unknown) => boolean;
    handleSubmit?: (payload: unknown) => unknown;
  } = {}) {
    const store = new OrderStore();
    await store.create();
    const submitted: string[] = [];
    const finished: { eventId: string; payload: unknown }[] = [];
    const traces: TransitionTrace[] = [];

    @Workflow<Order, string, State>({
      name: 'OrderWorkflow',
      entityService: orders,
      states: { finals: ['done', 'failed'], idles: idle ? ['review'] : [], failed: 'failed' },
      defaultCallbackTimeout: waitTimeout,
      transitions: [
        { from: ['pending'], to: 'review', event: submit.event },
        { from: ['review'], to: 'done', event: finishEvent, conditions: [(_order, payload) => canFinish(payload)] },
      ],
    })
    class OrderWorkflow {
      @OnEvent(submit.event)
      @WithRetry({ handler: 'submit', maxAttempts: 3, strategy: RetryStrategy.FIXED, initialDelay: 1 })
      async submit(
        @Entity() order: Order,
        @EventId() eventId: string,
        @Payload({}) payload: unknown,
      ): Promise<unknown> {
        submitted.push(eventId);
        order.notes.push('submitted');
        return handleSubmit(payload);
      }

      @OnEvent(finishEvent)
      async finish(@Entity() order: Order, @EventId() eventId: string, @Payload({}) payload: unknown): Promise<void> {
        finished.push({ eventId, payload });
        order.notes.push('finished');
      }
    }

    const telemetry: WorkflowTelemetry = {
      log() {},
      trace(entry) {
        traces.push(entry);
      },
    };
    const app = await Test.createTestingModule({
      imports: [
        WorkflowModule.register({
          entities: [{ provide: orders, useValue: store }],
          workflows: [OrderWorkflow],
          providers: [{ provide: WORKFLOW_TELEMETRY, useValue: telemetry }],
        }),
      ],
    }).compile();
    modules.push(app);
    await app.init();
    return { orchestrator: app.get(OrchestratorService), store, submitted, finished, traces };
  }

  test('processes one broker transition and replays the same continuation without repeating effects', async () => {
    const { orchestrator, store, submitted, finished } = await createWorkflow();
    const message = { urn: submit.urn, event: submit.event, eventId: submit.eventId, payload: submit.payload };
    const result = await processWorkflowMessage(orchestrator, message);
    if (result.status !== 'continued') throw new Error(`Expected a continuation, got ${result.status}`);
    expect(result.nextEvent).toMatchObject({
      urn: submit.urn,
      event: finishEvent,
      payload: { item: 'book' },
      attempt: 0,
    });
    expect(result.nextEvent.eventId).not.toBe(submit.eventId);
    expect((await store.load(submit.urn))?.state).toBe('review');
    expect(finished).toEqual([]);

    const final = { status: 'final', state: 'done' };
    await expect(processWorkflowMessage(orchestrator, result.nextEvent)).resolves.toEqual(final);
    await expect(processWorkflowMessage(orchestrator, { ...message })).resolves.toEqual(result);
    await expect(processWorkflowMessage(orchestrator, { ...result.nextEvent })).resolves.toEqual(final);
    expect(submitted).toEqual([submit.eventId]);
    expect(finished).toEqual([{ eventId: result.nextEvent.eventId, payload: { item: 'book' } }]);
  });

  test('recovers the original continuation on redelivery after routing throws after commit', async () => {
    const routingError = new Error('Review rules unavailable');
    let unavailable = true;
    const { orchestrator, store, submitted, finished } = await createWorkflow({
      canFinish: () => {
        if (unavailable) throw routingError;
        return true;
      },
    });

    await expect(processWorkflowMessage(orchestrator, submit)).rejects.toBe(routingError);
    expect((await store.load(submit.urn))?.state).toBe('review');
    unavailable = false;
    const result = await processWorkflowMessage(orchestrator, submit);
    expect(result).toMatchObject({ status: 'continued', nextEvent: { event: finishEvent, payload: { item: 'book' } } });
    expect(submitted).toEqual([submit.eventId]);
    expect(finished).toEqual([]);
  });

  test('rejects malformed envelopes without misclassifying workflow errors', async () => {
    const { orchestrator, submitted, traces } = await createWorkflow();
    for (const raw of [
      null,
      JSON.stringify(submit),
      [submit],
      {},
      Object.setPrototypeOf({}, submit),
      { ...submit, eventId: '  ' },
      { ...submit, eventId: 42 },
      { ...submit, event: '' },
      { ...submit, event: {} },
      { ...submit, urn: '  ' },
      { ...submit, urn: false },
      { ...submit, urn: Number.POSITIVE_INFINITY },
    ]) {
      await expect(processWorkflowMessage(orchestrator, raw)).rejects.toBeInstanceOf(InvalidWorkflowMessageError);
    }
    expect(traces).toEqual([]);

    const unknownEvent = processWorkflowMessage(orchestrator, { ...submit, event: 'order.unknown' });
    await expect(unknownEvent).rejects.toBeInstanceOf(BadRequestException);
    await expect(unknownEvent).rejects.not.toBeInstanceOf(InvalidWorkflowMessageError);
    expect(submitted).toEqual([]);
  });

  test('propagates a busy claim without applying handler retries', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { orchestrator, submitted, traces } = await createWorkflow({
      handleSubmit: async () => {
        started.resolve();
        await release.promise;
      },
    });
    const running = processWorkflowMessage(orchestrator, submit);
    try {
      await Promise.race([started.promise, running]);
      const competing = { ...submit, eventId: 'submit-competing' };
      await expect(processWorkflowMessage(orchestrator, competing)).rejects.toBeInstanceOf(ConflictException);
      expect(traces.map(({ attempt, outcome }) => ({ attempt, outcome }))).toEqual([{ attempt: 0, outcome: 'error' }]);
    } finally {
      release.resolve();
      await running;
    }
    expect(submitted).toEqual([submit.eventId]);
  });

  test('propagates a commit error, keeps state unchanged, and releases the claim for redelivery', async () => {
    let uncloneableOutput = true;
    const { orchestrator, store, submitted } = await createWorkflow({
      handleSubmit: (payload) => (uncloneableOutput ? () => {} : payload),
    });

    await expect(processWorkflowMessage(orchestrator, submit)).rejects.toMatchObject({ name: 'DataCloneError' });
    expect(await store.load(submit.urn)).toEqual({ id: 0, state: 'pending', notes: [] });
    expect(submitted).toEqual([submit.eventId]);

    uncloneableOutput = false;
    await expect(processWorkflowMessage(orchestrator, submit)).resolves.toMatchObject({ status: 'continued' });
    expect(await store.load(submit.urn)).toEqual({ id: 0, state: 'review', notes: ['submitted'] });
    expect(submitted).toEqual([submit.eventId, submit.eventId]);
  });

  test('uses the decorator retry budget with the same eventId and fresh entity state on each attempt', async () => {
    const finalFailure = new Error('Gateway still unavailable');
    let attempts = 0;
    const { orchestrator, store, submitted, traces } = await createWorkflow({
      handleSubmit: () => {
        if (++attempts < 3) throw new Error('Temporary gateway failure');
        throw finalFailure;
      },
    });

    await expect(processWorkflowMessage(orchestrator, { ...submit, attempt: 99 })).rejects.toBe(finalFailure);
    expect(traces.map(({ attempt, outcome }) => ({ attempt, outcome }))).toEqual([
      { attempt: 0, outcome: 'retry' },
      { attempt: 1, outcome: 'retry' },
      { attempt: 2, outcome: 'error' },
    ]);
    expect(await store.load(submit.urn)).toEqual({ id: 0, state: 'failed', notes: ['submitted'] });
    await expect(processWorkflowMessage(orchestrator, submit)).rejects.toThrow();
    expect(submitted).toEqual([submit.eventId, submit.eventId, submit.eventId]);
  });

  test('does not retry an unretriable handler failure', async () => {
    const { orchestrator, submitted } = await createWorkflow({
      handleSubmit: () => {
        throw new UnretriableException('Order declined');
      },
    });
    await expect(processWorkflowMessage(orchestrator, submit)).resolves.toEqual({ status: 'final', state: 'failed' });
    expect(submitted).toEqual([submit.eventId]);
  });

  test('runs automatic continuations in process and recovers when a handler attempt fails', async () => {
    let unavailable = true;
    const { orchestrator, submitted, finished } = await createWorkflow({
      handleSubmit: (payload) => {
        if (unavailable) {
          unavailable = false;
          throw new Error('Temporary gateway failure');
        }
        return payload;
      },
    });
    await expect(runInProcess(orchestrator, submit)).resolves.toEqual({ status: 'final', state: 'done' });
    expect(submitted).toEqual([submit.eventId, submit.eventId]);
    expect(finished).toEqual([{ eventId: expect.any(String), payload: { item: 'book' } }]);
  });

  test.each(['idle', 'no_transition'])('returns at %s and resumes only from a new external event', async (status) => {
    const { orchestrator, store, finished } = await createWorkflow({
      idle: status === 'idle',
      canFinish: (payload) => payload === 'approved',
    });
    await expect(runInProcess(orchestrator, submit)).resolves.toEqual({
      status,
      state: 'review',
      timeout: waitTimeout,
    });
    expect((await store.load(submit.urn))?.state).toBe('review');
    expect(finished).toEqual([]);

    const resume: IWorkflowEvent<unknown> = {
      urn: submit.urn,
      event: finishEvent,
      eventId: 'review-1',
      payload: 'approved',
      attempt: 0,
    };
    await expect(runInProcess(orchestrator, resume)).resolves.toEqual({ status: 'final', state: 'done' });
    expect(finished).toEqual([{ eventId: 'review-1', payload: 'approved' }]);
  });
});

test('keeps numeric and string entity URNs distinct, including cancellation', async () => {
  const store = new OrderStore();
  await store.create();
  const other = await store.create('0');
  await store.update(other, 'done');
  await expect(store.cancellation.request('0')).resolves.toBe(true);
  await expect(store.claimTransition('0', submit.eventId)).resolves.toEqual({ kind: 'cancelled' });
  await expect(store.cancellation.isRequested(0)).resolves.toBe(false);
  await expect(store.load(0)).resolves.toMatchObject({ id: 0, state: 'pending' });
  await expect(store.load('0')).resolves.toMatchObject({ id: '0', state: 'done' });
});

test('in-memory claims isolate snapshots and reject a stale owner after reacquisition', async () => {
  const store = new OrderStore();
  const order = await store.create();
  order.notes.push('outside storage');
  const first = await store.claimTransition(submit.urn, submit.eventId);
  if (first.kind !== 'acquired') throw new Error(`Expected an acquired claim, got ${first.kind}`);
  expect(first.entity.notes).toEqual([]);
  first.entity.notes.push('abandoned');
  await expect(store.update(order, 'done')).rejects.toThrow();
  await first.release();

  const second = await store.claimTransition(submit.urn, submit.eventId);
  if (second.kind !== 'acquired') throw new Error(`Expected an acquired claim, got ${second.kind}`);
  expect(second.entity.notes).toEqual([]);
  const metadata = {
    urn: submit.urn,
    eventId: submit.eventId,
    event: submit.event,
    workflow: 'OrderWorkflow',
    from: 'pending',
  };
  await expect(first.commit('done', { kind: 'applied', output: null }, metadata)).rejects.toThrow();
  await first.release();
  await expect(store.claimTransition(submit.urn, 'another-event')).resolves.toEqual({ kind: 'busy' });

  second.entity.notes.push('committed');
  const output = { approved: true };
  const committed = await second.commit('review', { kind: 'applied', output }, metadata);
  committed.entity.notes.push('outside receipt');
  output.approved = false;
  const stored = await store.load(submit.urn);
  expect(stored).toEqual({ id: 0, state: 'review', notes: ['committed'] });
  stored?.notes.push('outside load');
  const replay = await store.claimTransition(submit.urn, submit.eventId);
  if (replay.kind !== 'completed') throw new Error(`Expected a completed claim, got ${replay.kind}`);
  const expected = {
    entity: { id: 0, state: 'review', notes: ['committed'] },
    completion: { kind: 'applied', output: { approved: true } },
  };
  expect(replay.receipt).toEqual(expected);
  replay.receipt.entity.notes.push('outside replay');
  await expect(store.claimTransition(submit.urn, submit.eventId)).resolves.toEqual({
    kind: 'completed',
    receipt: expected,
  });
});
