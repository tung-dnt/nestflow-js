import type { Observable } from 'rxjs';
import type { TransitionCompletion } from './entity.interface';

export const WORKFLOW_HISTORY = Symbol('WORKFLOW_HISTORY');

/** One committed transition, built by the orchestrator and stored with its receipt. */
export interface WorkflowHistoryEntry {
  workflow: string;
  event: string;
  eventId: string;
  urn: string | number;
  from: string | number;
  to: string | number;
  outcome: TransitionCompletion['kind'];
  attempt: number;
  committedAtMs: number;
  /** Handler failure that moved the entity to the failed state. */
  error?: { name: string; message: string };
  /** Event payload, only for workflows that set `history: { payload: true }`. */
  payload?: unknown;
}

export interface WorkflowHistoryPage {
  entries: WorkflowHistoryEntry[];
  cursor?: string;
}

/**
 * Host-provided transition history. Methods return cold Observables that emit once.
 * `record()` receives each committed entry at least once, before the adapter sees the
 * result; deduplicate by `urn` and `eventId`. Omit it when `list()` reads entries the
 * host already stores, such as receipts or durable checkpoints.
 */
export interface WorkflowHistory {
  record?(entry: WorkflowHistoryEntry): Observable<void>;
  /** `limit` caps one storage page, so a page can hold fewer entries. */
  list(urn: string | number, limit: number, cursor?: string): Observable<WorkflowHistoryPage>;
}
