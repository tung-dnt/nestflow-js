import type { IWorkflowEvent, TransitResult } from '@/core';
import { WorkflowCancelledException } from '@/exception/workflow-cancelled.exception';

export type WorkflowConsumer = (raw: unknown) => Promise<TransitResult>;

/**
 * Run the consumer, then publish its continuation, so the broker acknowledges only after
 * the handoff. A crash in between redelivers the message, which replays the receipt and
 * publishes the same continuation event ID again.
 */
export async function deliverWorkflowMessage(
  consume: WorkflowConsumer,
  publish: (event: IWorkflowEvent<unknown>) => Promise<void>,
  raw: unknown,
): Promise<void> {
  let result: TransitResult;
  try {
    result = await consume(raw);
  } catch (error) {
    // A cancelled entity accepts no further work, so redelivery cannot help.
    if (error instanceof WorkflowCancelledException) return;
    throw error;
  }
  if (result.status === 'continued') await publish(result.nextEvent);
}
