import type { IWorkflowEntity, TransitionClaim, TransitionReceipt } from '@/core';
import { defer, of, type Observable } from 'rxjs';

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

  abstract create(): Observable<T>;

  readonly cancellation = {
    request: (urn: string | number) =>
      defer(() => {
        const row = this.rows.get(urn);
        if (!row) return of(false);
        row.cancelled = true;
        return of(true);
      }),
    isRequested: (urn: string | number) => defer(() => of(this.rows.get(urn)?.cancelled === true)),
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

  load(urn: string | number): Observable<T | null> {
    return defer(() => {
      const row = this.rows.get(urn);
      return of(row ? structuredClone(row.entity) : null);
    });
  }

  update(entity: T, state: T[StateKey]): Observable<T> {
    return defer(() => of(this.save({ ...entity, [this.stateKey]: state })));
  }

  status(entity: T): T[StateKey] {
    return entity[this.stateKey];
  }

  urn(entity: T): T['id'] {
    return entity.id;
  }

  claimTransition(urn: string | number, eventId: string): Observable<TransitionClaim<T, T[StateKey]>> {
    return defer(() => of(this.acquire(urn, eventId)));
  }

  private acquire(urn: string | number, eventId: string): TransitionClaim<T, T[StateKey]> {
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
      commit: (state, completion, history) =>
        defer(() => {
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
          return of(receipt);
        }),
      release: () =>
        defer(() => {
          if (row.owner === owner) row.owner = undefined;
          return of(undefined);
        }),
    };
  }

  protected clear(): void {
    this.rows.clear();
  }
}
