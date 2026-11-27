import type { Observable } from 'rxjs';
import type { TransitionCompletion, TransitionReceipt } from './entity.interface';

export const WORKFLOW_HISTORY = Symbol('WORKFLOW_HISTORY');

/** Persistence methods return cold Observables that emit exactly once and complete on success. */
export interface WorkflowCancellationStore {
  /** Persist an idempotent stop request. Return false if the entity does not exist. */
  request(urn: string | number): Observable<boolean>;
  isRequested(urn: string | number): Observable<boolean>;
}

export interface TransitionCommitMetadata {
  workflow: string;
  event: string;
  eventId: string;
  urn: string | number;
  from: string | number;
}

export interface WorkflowHistoryEntry extends TransitionCommitMetadata {
  to: string | number;
  outcome: TransitionCompletion['kind'];
  committedAtMs: number;
}

export interface WorkflowHistoryReader {
  listTransitions(
    urn: string | number,
    limit: number,
    cursor?: string,
  ): Observable<{
    entries: WorkflowHistoryEntry[];
    cursor?: string;
  }>;
}

export interface RecoveryClaim {
  transition: TransitionCommitMetadata;
  receipt: TransitionReceipt<unknown>;
  acknowledge(): Observable<void>;
}

export interface WorkflowRecoveryStore {
  /** Claim pending work under a finite lease. Only the current owner can acknowledge it. */
  claimPending(): Observable<RecoveryClaim | undefined>;
}
