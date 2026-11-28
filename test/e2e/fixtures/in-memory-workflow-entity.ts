import { InMemoryWorkflowEntity as MemoryStore } from '@/adapter/in-memory-workflow-entity';
import { defer, map } from 'rxjs';

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

  override claimTransition(urn: string | number, eventId: string) {
    return super.claimTransition(urn, eventId).pipe(
      map((claim) => {
        const beforeCommit = this.beforeCommit;
        if (claim.kind !== 'acquired' || !beforeCommit) return claim;
        return {
          ...claim,
          commit: (...args: Parameters<typeof claim.commit>) =>
            defer(() => {
              beforeCommit(args[0]);
              return claim.commit(...args);
            }),
        };
      }),
    );
  }

  override clear(): void {
    super.clear();
  }
}
