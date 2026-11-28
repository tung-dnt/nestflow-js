import type { IWorkflowEntity, TransitionClaim, TransitionReceipt } from '@/core';

type WorkflowRow<T> = {
  entity: T;
  owner?: symbol;
  cancelled?: true;
  receipts: Map<string, TransitionReceipt<T>>;
};

/** Single-process storage for structured-cloneable entities and transition receipts. */
export abstract class InMemoryWorkflowEntity<
  T extends { id: string | number },
  StateKey extends keyof T,
> implements IWorkflowEntity<T, T[StateKey]> {
  private readonly rows = new Map<string | number, WorkflowRow<T>>();

  constructor(private readonly stateKey: StateKey) {}

  abstract create(): Promise<T>;

  readonly cancellation = {
    request: async (urn: string | number) => {
      const row = this.rows.get(urn);
      if (!row) return false;
      row.cancelled = true;
      return true;
    },
    isRequested: async (urn: string | number) => this.rows.get(urn)?.cancelled === true,
  };

  /** Persist a detached snapshot without exposing a live reference to storage. */
  protected save(entity: T): T {
    const key = this.urn(entity);
    const snapshot = structuredClone(entity);
    const row = this.rows.get(key);
    if (row?.owner !== undefined) throw new Error(`Entity ${key} already has a transition in progress`);
    if (row) row.entity = snapshot;
    else this.rows.set(key, { entity: snapshot, receipts: new Map() });
    return entity;
  }

  async load(urn: string | number): Promise<T | null> {
    const row = this.rows.get(urn);
    return row ? structuredClone(row.entity) : null;
  }

  async update(entity: T, state: T[StateKey]): Promise<T> {
    return this.save({ ...entity, [this.stateKey]: state });
  }

  status(entity: T): T[StateKey] {
    return entity[this.stateKey];
  }

  urn(entity: T): T['id'] {
    return entity.id;
  }

  async claimTransition(urn: string | number, eventId: string): Promise<TransitionClaim<T, T[StateKey]>> {
    const row = this.rows.get(urn);
    if (!row) return { kind: 'missing' };
    if (row.cancelled) return { kind: 'cancelled' };
    const completed = row.receipts.get(eventId);
    if (completed) return { kind: 'completed', receipt: structuredClone(completed) };
    if (row.owner !== undefined) return { kind: 'busy' };

    const entity = structuredClone(row.entity);
    const owner = Symbol();
    row.owner = owner;
    return {
      kind: 'acquired',
      entity,
      commit: async (state, completion, history) => {
        const receipt: TransitionReceipt<T> = {
          entity: { ...entity, [this.stateKey]: state },
          completion,
          ...(history && { history }),
        };
        const snapshot = structuredClone(receipt);
        if (row.owner !== owner || this.rows.get(urn) !== row) {
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

  protected clear(): void {
    this.rows.clear();
  }
}
