import type { OrchestratorService, TransitResult, WorkflowRecoveryStore } from '@/core';
import { WorkflowCancelledException } from '@/exception/workflow-cancelled.exception';

/** Process one persisted continuation. Deliver must resolve only after the handoff is durable. */
export async function recoverNextTransition(
  orchestrator: OrchestratorService,
  store: WorkflowRecoveryStore,
  deliver: (result: TransitResult) => Promise<void>,
): Promise<boolean> {
  const claim = await store.claimPending();
  if (!claim) return false;

  let result: TransitResult | undefined;
  try {
    result = await orchestrator.resumeCommitted(claim.transition, claim.receipt);
  } catch (error) {
    if (!(error instanceof WorkflowCancelledException)) throw error;
  }
  if (result) await deliver(result);
  await claim.acknowledge();
  return true;
}
