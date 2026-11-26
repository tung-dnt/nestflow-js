import type { TransitionCompletion, TransitionReceipt } from './entity.interface';

export const WORKFLOW_HISTORY = Symbol('WORKFLOW_HISTORY');

export interface WorkflowCancellationStore {
  /** Persist an idempotent stop request. Return false if the entity does not exist. */
  request(urn: string | number): Promise<boolean>;
  isRequested(urn: string | number): Promise<boolean>;
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
  ): Promise<{
    entries: WorkflowHistoryEntry[];
    cursor?: string;
  }>;
}

export interface RecoveryClaim {
  transition: TransitionCommitMetadata;
  receipt: TransitionReceipt<unknown>;
  acknowledge(): Promise<void>;
}

export interface WorkflowRecoveryStore {
  /** Claim pending work under a finite lease. Only the current owner can acknowledge it. */
  claimPending(): Promise<RecoveryClaim | undefined>;
}
