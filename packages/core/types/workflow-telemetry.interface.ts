import type { TransitionCompletion } from './entity.interface';
import type { TransitResult } from './transit-result.type';

export const WORKFLOW_TELEMETRY = Symbol('WORKFLOW_TELEMETRY');

export interface TransitionTelemetryContext {
  workflow: string;
  event: string;
  attempt: number;
}

export type TransitionLog = TransitionTelemetryContext &
  (
    | { kind: 'claim_busy' | 'commit_unconfirmed' | 'retry_requested' }
    | { kind: 'receipt_replayed'; outcome: TransitionCompletion['kind'] }
    | {
        kind: 'transition_committed';
        from: string | number;
        to: string | number;
        outcome: TransitionCompletion['kind'];
      }
  );

export interface TransitionTrace extends Partial<TransitionTelemetryContext> {
  startedAtMs: number;
  durationMs: number;
  outcome: TransitResult['status'] | 'retry' | 'error';
}

/** Host-provided telemetry. Methods may enqueue work, but are never awaited by the orchestrator. */
export interface WorkflowTelemetry {
  log(entry: TransitionLog): void | Promise<void>;
  trace(entry: TransitionTrace): void | Promise<void>;
}
