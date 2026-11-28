import type { Duration } from './shared.type';
import type { IWorkflowEvent } from './workflow-event.interface';
import type { WorkflowHistoryEntry } from './workflow-history.interface';

/**
 * Discriminated union returned by {@link OrchestratorService.transit}.
 *
 * Each variant tells the caller what happened and what to do next:
 *
 * | Status          | Meaning                                            |
 * |-----------------|----------------------------------------------------|
 * | `final`         | Entity reached a terminal state — workflow done.   |
 * | `idle`          | Entity is idle, waiting for an external callback.  |
 * | `continued`     | Auto-transition found — feed `nextEvent` back in.  |
 * | `no_transition` | No unambiguous next step — wait for explicit event.|
 *
 * Adapters consume this via `BaseWorkflowAdapter` handler methods or a
 * manual `switch` on `result.status`. `history` is the committed entry when a
 * `WORKFLOW_HISTORY` provider is registered, so checkpointing adapters store it.
 */
export type TransitResult = (
  | { status: 'final'; state: string | number }
  | { status: 'idle'; state: string | number; timeout?: Duration }
  | { status: 'continued'; nextEvent: IWorkflowEvent }
  | { status: 'no_transition'; state: string | number; timeout?: Duration }
) & { history?: WorkflowHistoryEntry };
