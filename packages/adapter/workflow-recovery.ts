import type { OrchestratorService, TransitResult, WorkflowRecoveryStore } from '@/core';

/** Process one persisted continuation. Deliver must resolve only after the handoff is durable. */
export async function recoverNextTransition(
  orchestrator: OrchestratorService,
  store: WorkflowRecoveryStore,
  deliver: (result: TransitResult) => Promise<void>,
): Promise<boolean> {
  const claim = await store.claimPending();
  if (!claim) return false;

  await deliver(orchestrator.resumeCommitted(claim.transition, claim.receipt));
  await claim.acknowledge();
  return true;
}
