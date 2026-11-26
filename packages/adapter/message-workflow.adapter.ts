import { RetryBackoff, type IWorkflowEvent, type OrchestratorService, type TransitResult } from '@/core';
import { BadRequestException } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';

/** The broker message is malformed, rather than rejected by the workflow engine. */
export class InvalidWorkflowMessageError extends BadRequestException {}

/** Process one logical transition from a decoded broker message. The producer must supply its stable eventId. */
export async function processWorkflowMessage(orchestrator: OrchestratorService, raw: unknown): Promise<TransitResult> {
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
  return executeTransition(orchestrator, {
    event,
    eventId,
    urn,
    payload: Object.hasOwn(raw, 'payload') ? raw.payload : undefined,
    attempt: 0,
  });
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Follow automatic continuations and return at the first terminal state or external-input wait. */
export async function runInProcess(
  orchestrator: OrchestratorService,
  event: IWorkflowEvent<unknown>,
): Promise<Exclude<TransitResult, { status: 'continued' }>> {
  let current = { ...event, attempt: 0 };
  while (true) {
    const result = await executeTransition(orchestrator, current);
    if (result.status !== 'continued') return result;
    current = result.nextEvent;
  }
}

async function executeTransition(
  orchestrator: OrchestratorService,
  event: IWorkflowEvent<unknown>,
): Promise<TransitResult> {
  const retry = orchestrator.getRetryConfig(event.event);
  if (!retry) return orchestrator.transitAttempt(event, false);

  for (let attempt = 1; attempt < retry.maxAttempts; attempt++) {
    const result = await orchestrator.transitAttempt(event, true);
    if (result.status !== 'retry') return result;

    const delay = RetryBackoff.calculateDelay(event.attempt, retry);
    if (delay > 0) await setTimeout(delay);
    event = { ...event, attempt };
  }
  return orchestrator.transitAttempt(event, false);
}
