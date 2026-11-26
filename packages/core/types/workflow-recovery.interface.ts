import type { TransitionCompletion, TransitionReceipt } from './entity.interface';

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
