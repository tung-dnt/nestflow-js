import { BadRequestException, type INestApplicationContext } from '@nestjs/common';
import { OrchestratorService, RetryBackoff, type IWorkflowEvent, type TransitResult } from '@/core';
import { randomUUID } from 'node:crypto';
import { BaseWorkflowAdapter } from './base-workflow.adapter';

export interface DurableWorkflowEvent {
  urn: string | number;
  eventId: string;
  initialEvent: string;
  payload?: any;
}

export interface DurableWorkflowResult {
  urn: string | number;
  status: string;
  state: string | number;
}

/**
 * Minimal interface for the AWS Durable Execution SDK's DurableContext.
 * The actual SDK (`@aws/durable-execution-sdk-js`) is a peer dependency — only needed at runtime.
 */
export interface IDurableContext {
  step<T>(
    name: string,
    fn: () => Promise<T>,
    options?: { retryStrategy?: (error: Error, attemptCount: number) => { shouldRetry: boolean } },
  ): Promise<T>;
  waitForCallback<T>(
    name: string,
    onRegister: (callbackId: string) => Promise<void>,
    options?: { timeout?: { hours?: number; minutes?: number; seconds?: number } },
  ): Promise<T>;
  wait(duration: { seconds?: number; minutes?: number; hours?: number }): Promise<void>;
  logger: { info(msg: string, data?: any): void };
}

type DurableWorkflowHandler = (event: DurableWorkflowEvent, ctx: IDurableContext) => Promise<DurableWorkflowResult>;

export type WithDurableExecution<WrappedHandler = DurableWorkflowHandler> = (
  handler: DurableWorkflowHandler,
) => WrappedHandler;

const DEFAULT_CALLBACK_TIMEOUT = { hours: 24 };
const NO_STEP_RETRY = { retryStrategy: () => ({ shouldRetry: false }) };

/**
 * Parse a callback result from the SDK.
 * The real SDK delivers callback results as JSON strings via SendDurableExecutionCallbackSuccess.
 */
function parseCallbackResult(raw: unknown): { event: string; payload?: unknown } {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Invalid workflow callback JSON');
    }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('event' in value) ||
    typeof value.event !== 'string' ||
    !value.event.trim()
  ) {
    throw new BadRequestException('Workflow callback event is required');
  }
  return { event: value.event, payload: 'payload' in value ? value.payload : undefined };
}

class DurableLambdaWorkflowAdapter extends BaseWorkflowAdapter<IDurableContext, DurableWorkflowResult> {
  async run(event: DurableWorkflowEvent, ctx: IDurableContext): Promise<DurableWorkflowResult> {
    if (typeof event.eventId !== 'string' || !event.eventId.trim()) {
      throw new BadRequestException('A stable workflow eventId is required');
    }

    const initialEvent: IWorkflowEvent = {
      event: event.initialEvent,
      urn: event.urn,
      eventId: event.eventId,
      payload: event.payload,
      attempt: 0,
    };
    return this.runWorkflowLoop(initialEvent, ctx);
  }

  protected async executeTransit(
    currentEvent: IWorkflowEvent,
    iteration: number,
    ctx: IDurableContext,
  ): Promise<TransitResult> {
    const retryConfig = this.orchestrator.getRetryConfig(currentEvent.event);
    const maxAttempts = retryConfig?.maxAttempts ?? 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const checkpoint = await ctx.step<TransitResult | { status: 'retry'; delayMs: number }>(
        `transit:${currentEvent.event}:${iteration}:${attempt}`,
        async () => {
          const params = { ...currentEvent, attempt };
          if (!retryConfig || attempt + 1 === maxAttempts) {
            return this.orchestrator.transitAttempt(params, false);
          }

          const result = await this.orchestrator.transitAttempt(params, true);
          return result.status === 'retry'
            ? { status: 'retry', delayMs: RetryBackoff.calculateDelay(attempt, retryConfig) }
            : result;
        },
        NO_STEP_RETRY,
      );

      if (checkpoint.status !== 'retry') return checkpoint;
      const { delayMs } = checkpoint;
      ctx.logger.info(
        `Handler ${currentEvent.event} failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delayMs}ms`,
      );
      if (delayMs !== 0) await ctx.wait({ seconds: Math.ceil(delayMs / 1000) });
    }

    throw new Error(`No transit result within retry budget for event: ${currentEvent.event}`);
  }

  protected onFinal(
    result: Extract<TransitResult, { status: 'final' }>,
    event: IWorkflowEvent,
    _ctx: IDurableContext,
  ): DurableWorkflowResult {
    return { urn: event.urn, status: 'completed', state: result.state };
  }

  protected async onIdle(
    result: Extract<TransitResult, { status: 'idle' }>,
    event: IWorkflowEvent,
    iteration: number,
    ctx: IDurableContext,
  ): Promise<IWorkflowEvent> {
    const timeout = result.timeout ?? DEFAULT_CALLBACK_TIMEOUT;
    const raw = await ctx.waitForCallback<string>(
      `idle:${result.state}:${iteration}`,
      async (callbackId: string) => {
        ctx.logger.info(`Waiting for callback at idle state ${result.state}`, { callbackId });
      },
      { timeout },
    );
    return {
      ...parseCallbackResult(raw),
      urn: event.urn,
      eventId: await ctx.step(`callback-event-id:${iteration}`, async () => randomUUID(), NO_STEP_RETRY),
      attempt: 0,
    };
  }

  protected async onContinued(
    result: Extract<TransitResult, { status: 'continued' }>,
    iteration: number,
    ctx: IDurableContext,
  ): Promise<IWorkflowEvent> {
    return ctx.step(`${result.nextEvent.event}:${iteration}`, async () => result.nextEvent);
  }

  protected async onNoTransition(
    result: Extract<TransitResult, { status: 'no_transition' }>,
    event: IWorkflowEvent,
    iteration: number,
    ctx: IDurableContext,
  ): Promise<IWorkflowEvent> {
    const timeout = result.timeout ?? DEFAULT_CALLBACK_TIMEOUT;
    const raw = await ctx.waitForCallback<string>(
      `awaiting:${result.state}:${iteration}`,
      async (callbackId: string) => {
        ctx.logger.info(`No auto-transition from ${result.state}, waiting for explicit event`, { callbackId });
      },
      { timeout },
    );
    return {
      ...parseCallbackResult(raw),
      urn: event.urn,
      eventId: await ctx.step(`callback-event-id:${iteration}`, async () => randomUUID(), NO_STEP_RETRY),
      attempt: 0,
    };
  }
}

/**
 * Wrap an invocation in AWS Durable Execution. Each checkpointed attempt
 * replays its stored result. An attempt interrupted before checkpointing can run again.
 *
 * @param app - NestJS application context
 * @param withDurableExecution - The `withDurableExecution` function from `@aws/durable-execution-sdk-js`
 */
export const DurableLambdaEventHandler = <WrappedHandler>(
  app: INestApplicationContext,
  withDurableExecution: WithDurableExecution<WrappedHandler>,
): WrappedHandler => {
  const orchestrator = app.get(OrchestratorService);
  const adapter = new DurableLambdaWorkflowAdapter(orchestrator);

  return withDurableExecution(async (event: DurableWorkflowEvent, ctx: IDurableContext) => {
    return adapter.run(event, ctx);
  });
};
