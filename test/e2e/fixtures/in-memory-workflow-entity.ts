import { InMemoryWorkflowEntity as MemoryStore } from '@/adapter/in-memory-workflow-entity';
import type { TransitionClaim } from '@/core';

export abstract class InMemoryWorkflowEntity<T extends { id: string }, StateKey extends keyof T> extends MemoryStore<
  T,
  StateKey
> {
  constructor(
    stateKey: StateKey,
    private readonly beforeCommit?: (state: T[StateKey]) => void,
  ) {
    super(stateKey);
  }

  override async claimTransition(urn: string | number, eventId: string): Promise<TransitionClaim<T, T[StateKey]>> {
    const claim = await super.claimTransition(urn, eventId);
    const beforeCommit = this.beforeCommit;
    if (claim.kind !== 'acquired' || !beforeCommit) return claim;
    return {
      ...claim,
      commit: async (...args) => {
        beforeCommit(args[0]);
        return claim.commit(...args);
      },
    };
  }

  override clear(): void {
    super.clear();
  }
}
