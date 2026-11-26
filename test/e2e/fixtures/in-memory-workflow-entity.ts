import type { IWorkflowEntity, TransitionClaim, TransitionReceipt } from '@/core';

type WorkflowRow<T> = {
  entity: T;
  owner?: symbol;
  receipts: Map<string, TransitionReceipt<T>>;
};

export abstract class InMemoryWorkflowEntity<
  T extends { id: string },
  StateKey extends keyof T,
> implements IWorkflowEntity<T, T[StateKey]> {
  private readonly rows = new Map<string, WorkflowRow<T>>();

  constructor(
    private readonly stateKey: StateKey,
    private readonly beforeCommit?: (state: T[StateKey]) => void,
  ) {}

  abstract create(): Promise<T>;

  protected save(entity: T): T {
    const snapshot = structuredClone(entity);
    const row = this.rows.get(entity.id);
    if (row) row.entity = snapshot;
    else this.rows.set(entity.id, { entity: snapshot, receipts: new Map() });
    return entity;
  }

  async load(urn: string | number): Promise<T | null> {
    const row = this.rows.get(String(urn));
    return row ? structuredClone(row.entity) : null;
  }

  async update(entity: T, state: T[StateKey]): Promise<T> {
    return this.save({ ...entity, [this.stateKey]: state });
  }

  status(entity: T): T[StateKey] {
    return entity[this.stateKey];
  }

  urn(entity: T): string {
    return entity.id;
  }

  async claimTransition(urn: string | number, eventId: string): Promise<TransitionClaim<T, T[StateKey]>> {
    const key = String(urn);
    const row = this.rows.get(key);
    if (!row) return { kind: 'missing' };
    const completed = row.receipts.get(eventId);
    if (completed) return { kind: 'completed', receipt: structuredClone(completed) };
    if (row.owner !== undefined) return { kind: 'busy' };

    const entity = structuredClone(row.entity);
    const owner = Symbol();
    row.owner = owner;
    return {
      kind: 'acquired',
      entity,
      commit: async (state, completion) => {
        const receipt: TransitionReceipt<T> = { entity: { ...entity, [this.stateKey]: state }, completion };
        const snapshot = structuredClone(receipt);
        this.beforeCommit?.(state);
        if (row.owner !== owner || this.rows.get(key) !== row) {
          throw new Error(`Transition claim no longer owns entity ${urn}`);
        }
        row.entity = snapshot.entity;
        row.receipts.set(eventId, snapshot);
        row.owner = undefined;
        return receipt;
      },
      release: async () => {
        if (row.owner === owner) row.owner = undefined;
      },
    };
  }

  clear(): void {
    this.rows.clear();
  }
}
