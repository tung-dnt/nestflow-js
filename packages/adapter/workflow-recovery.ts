import { catchError, concatMap, defer, map, of, share, throwError, type Observable } from 'rxjs';
import type { OrchestratorService, TransitResult, WorkflowRecoveryStore } from '@/core';
import { WorkflowCancelledException } from '@/exception/workflow-cancelled.exception';

/** Process one persisted continuation. Deliver must emit only after the handoff is durable. */
export function recoverNextTransition(
  orchestrator: OrchestratorService,
  store: WorkflowRecoveryStore,
  deliver: (result: TransitResult) => Observable<void>,
): Observable<boolean> {
  return defer(() =>
    store.claimPending().pipe(
      concatMap((claim) =>
        claim
          ? orchestrator.resumeCommitted(claim.transition, claim.receipt).pipe(
              catchError((error: unknown) =>
                error instanceof WorkflowCancelledException ? of(undefined) : throwError(() => error),
              ),
              concatMap((result) => (result ? deliver(result) : of(undefined))),
              concatMap(() => claim.acknowledge()),
              map(() => true),
            )
          : of(false),
      ),
      // A successful handoff must be acknowledged even if the observer disconnects.
      share({ resetOnRefCountZero: false }),
    ),
  );
}
