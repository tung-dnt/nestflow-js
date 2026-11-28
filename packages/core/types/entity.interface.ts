import type { Observable } from 'rxjs';
import type { WorkflowHistoryEntry } from './workflow-history.interface';

/** Persistence methods return cold Observables that emit exactly once and complete on success. */
export interface WorkflowCancellationStore {
  /** Persist an idempotent stop request. Return false if the entity does not exist. */
  request(urn: string | number): Observable<boolean>;
  isRequested(urn: string | number): Observable<boolean>;
}

export type TransitionCompletion =
  | { kind: 'applied'; output: unknown }
  | { kind: 'unretriable' }
  | { kind: 'exhausted' };

export interface TransitionReceipt<T> {
  entity: T;
  completion: TransitionCompletion;
  /** Entry passed to `commit()`; later claims for the event return it unchanged. */
  history?: WorkflowHistoryEntry;
}

export type TransitionClaim<T, State> =
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'cancelled' }
  | { kind: 'completed'; receipt: TransitionReceipt<T> }
  | {
      kind: 'acquired';
      entity: T;
      commit(
        state: State,
        completion: TransitionCompletion,
        history?: WorkflowHistoryEntry,
      ): Observable<TransitionReceipt<T>>;
      release(): Observable<void>;
    };

/** Persistence for entities and atomic receipts. Operations are cold and emit once, including `undefined` for void. */
export interface IWorkflowEntity<T = any, State = string | number> {
  /** When configured, new claims must atomically reject cancelled entities. */
  cancellation?: WorkflowCancellationStore;

  /**
   * Creates a new instance of the entity
   * @returns A new entity instance
   */
  create(): Observable<T>;

  /**
   * Updates the status of an entity
   * @param entity The entity to update
   * @param status The new status
   * @returns The updated entity
   */
  update(entity: T, status: State): Observable<T>;

  /**
   * Loads an entity by its URN
   * @param urn The unique resource name of the entity
   * @returns The loaded entity
   */
  load(urn: string | number): Observable<T | null>;

  /**
   * Atomically claim exclusive execution for an entity, or return the receipt
   * for this event ID. Commit must verify ownership, persist the state and
   * receipt together, and release the claim. Release may only clear its own
   * claim. A prior owner cannot commit after another worker acquires it.
   */
  claimTransition(urn: string | number, eventId: string): Observable<TransitionClaim<T, State>>;

  /**
   * Gets the current status of an entity
   * @param entity The entity
   * @returns The current status
   */
  status(entity: T): State;

  /**
   * Gets the URN of an entity
   * @param entity The entity
   * @returns The entity's URN
   */
  urn(entity: T): string | number;
}
