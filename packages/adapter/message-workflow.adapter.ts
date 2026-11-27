import { concatMap, defer, EMPTY, expand, filter, of, take, timer, type Observable } from 'rxjs';
import { RetryBackoff, type IWorkflowEvent, type OrchestratorService, type TransitResult } from '@/core';
import { BadRequestException } from '@nestjs/common';

/** The broker message is malformed, rather than rejected by the workflow engine. */
export class InvalidWorkflowMessageError extends BadRequestException {}

/** Process one logical transition from a decoded broker message. The producer must supply its stable eventId. */
export function processWorkflowMessage(orchestrator: OrchestratorService, raw: unknown): Observable<TransitResult> {
  return defer(() => executeTransition(orchestrator, parseMessage(raw)));
}

function parseMessage(raw: unknown): IWorkflowEvent<unknown> {
  if (!isMessageObject(raw)) throw new InvalidWorkflowMessageError('Expected a workflow event object');

  const eventId = Object.hasOwn(raw, 'eventId') ? raw.eventId : undefined;
  if (typeof eventId !== 'string' || !eventId.trim()) {
    throw new InvalidWorkflowMessageError('A stable workflow eventId is required');
  }
  const event = Object.hasOwn(raw, 'event') ? raw.event : undefined;
  if (typeof event !== 'string' || !event.trim()) {
    throw new InvalidWorkflowMessageError('A workflow event name is required');
  }
  const urn = Object.hasOwn(raw, 'urn') ? raw.urn : undefined;
  if ((typeof urn !== 'string' || !urn.trim()) && (typeof urn !== 'number' || !Number.isFinite(urn))) {
    throw new InvalidWorkflowMessageError('A workflow entity urn is required');
  }
  return {
    event,
    eventId,
    urn,
    payload: Object.hasOwn(raw, 'payload') ? raw.payload : undefined,
    attempt: 0,
  };
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follow automatic continuations and return at the first terminal state or external-input wait. */
export function runInProcess(
  orchestrator: OrchestratorService,
  event: IWorkflowEvent<unknown>,
): Observable<Exclude<TransitResult, { status: 'continued' }>> {
  return defer(() => executeTransition(orchestrator, { ...event, attempt: 0 })).pipe(
    expand((result) => (result.status === 'continued' ? executeTransition(orchestrator, result.nextEvent) : EMPTY)),
    filter((result) => result.status !== 'continued'),
    take(1),
  );
}

function executeTransition(
  orchestrator: OrchestratorService,
  event: IWorkflowEvent<unknown>,
): Observable<TransitResult> {
  const retry = orchestrator.getRetryConfig(event.event);
  if (!retry) return orchestrator.transitAttempt(event, false);

  return orchestrator.transitAttempt(event, event.attempt + 1 < retry.maxAttempts).pipe(
    expand((result, index) => {
      if (result.status !== 'retry') return EMPTY;
      const attempt = event.attempt + index + 1;
      const delay = RetryBackoff.calculateDelay(attempt - 1, retry);
      return (delay > 0 ? timer(delay) : of(0)).pipe(
        concatMap(() => orchestrator.transitAttempt({ ...event, attempt }, attempt + 1 < retry.maxAttempts)),
      );
    }),
    filter((result) => result.status !== 'retry'),
    take(1),
  );
}
