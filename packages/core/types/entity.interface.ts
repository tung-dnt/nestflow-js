export type TransitionCompletion =
  | { kind: 'applied'; output: unknown }
  | { kind: 'unretriable' }
  | { kind: 'exhausted' };

export interface TransitionReceipt<T> {
  entity: T;
  completion: TransitionCompletion;
}

export type TransitionClaim<T, State> =
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'completed'; receipt: TransitionReceipt<T> }
  | {
      kind: 'acquired';
      entity: T;
      commit(state: State, completion: TransitionCompletion): Promise<TransitionReceipt<T>>;
      release(): Promise<void>;
    };

/** Persistence contract for entities and atomic workflow transition receipts. */
export interface IWorkflowEntity<T = any, State = string | number> {
  /**
   * Creates a new instance of the entity
   * @returns A new entity instance
   */
  create(): Promise<T>;

  /**
   * Updates the status of an entity
   * @param entity The entity to update
   * @param status The new status
   * @returns The updated entity
   */
  update(entity: T, status: State): Promise<T>;

  /**
   * Loads an entity by its URN
   * @param urn The unique resource name of the entity
   * @returns The loaded entity
   */
  load(urn: string | number): Promise<T | null>;

  /**
   * Atomically claim exclusive execution for an entity, or return the receipt
   * for this event ID. Commit must verify ownership, persist the state and
   * receipt together, and release the claim. Release may only clear its own
   * claim. A prior owner cannot commit after another worker acquires it.
   */
  claimTransition(urn: string | number, eventId: string): Promise<TransitionClaim<T, State>>;

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
