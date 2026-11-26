import type { Duration, IBackoffRetryConfig, ITransitionEvent, IWorkflowEntity } from '@/core';

/**
 * Defines the structure of a workflow definition, which includes the following properties:
 * - `FinalStates`: An array of states that represent the final states of the workflow.
 * - `IdleStates`: An array of states that represent the idle states of the workflow.
 * - `FailedState`: The state that represents a failed state in the workflow.
 * - `Transitions`: An array of transition events that define the allowed transitions between states.
 * - `Fallback`: An optional function that can be used as a fallback when a transition event is not defined.
 * - `Conditions`: An optional array of condition functions.
 * - `Entity`: An optional entity service or configuration for loading/updating entities.
 */
/**
 * An idle state entry — either a bare state value or a state with a per-state
 * callback timeout that overrides {@link IWorkflowDefinition.defaultCallbackTimeout}.
 */
export type IdleStateEntry<State> = State | { state: State; timeout?: Duration };

/**
 * Complete definition of a workflow, passed to the {@link Workflow} class decorator.
 *
 * @typeParam T     - Entity type (e.g. `Order`)
 * @typeParam Event - Union of event names (e.g. `OrderEvent`)
 * @typeParam State - Union of state values (e.g. `OrderStatus`)
 *
 * @example
 * ```typescript
 * @Workflow<Order, OrderEvent, OrderStatus>({
 *   name: 'OrderWorkflow',
 *   states: {
 *     finals: [OrderStatus.Completed, OrderStatus.Cancelled],
 *     idles:  [OrderStatus.Pending],
 *     failed: OrderStatus.Failed,
 *   },
 *   transitions: [
 *     { from: [OrderStatus.Pending], to: OrderStatus.Processing, event: OrderEvent.Submit },
 *   ],
 *   entityService: 'entity.order',
 * })
 * ```
 */
export interface IWorkflowDefinition<T, Event, State> {
  /** Human-readable workflow name (used in logs). */
  name: string;
  /** Categorised states that drive the orchestrator's routing behaviour. */
  states: {
    /** Terminal states — reaching one ends the workflow. */
    finals: State[];
    /** Idle states — the workflow pauses and waits for an external callback. */
    idles: IdleStateEntry<State>[];
    /** The state to transition to when a handler throws an error. */
    failed: State;
  };
  /**
   * Default timeout for callback waits (idle & no_transition states).
   * Per-state timeouts in `idles` take precedence over this value.
   */
  defaultCallbackTimeout?: Duration;
  /** Allowed transitions between states, guarded by optional conditions. */
  transitions: ITransitionEvent<T, Event, State, any>[];
  /** Global conditions evaluated on every transition in this workflow. */
  conditions?: (<P>(entity: T, payload?: P | T | object | string) => boolean)[];
  /**
   * NestJS injection token for the {@link IWorkflowEntity} service that
   * handles persistence for this workflow's entities.
   */
  entityService: string;
}

/**
 * Internal route entry built by {@link OrchestratorService} during module
 * initialisation. Maps an event name to everything needed to execute a transition.
 * @internal
 */
export interface IWorkflowDefaultRoute {
  instance: object;
  definition: IWorkflowDefinition<unknown, string, string | number>;
  handlerName: string;
  handler: (...payload: unknown[]) => Promise<unknown>;
  defaultHandler?: TDefaultHandler<unknown>;
  entityService: IWorkflowEntity;
  retryConfig?: IBackoffRetryConfig;
}

/**
 * Metadata entry created by the {@link OnEvent} decorator.
 * Stored on the workflow class via `Reflect.defineMetadata`.
 * @internal
 */
export interface IWorkflowHandler {
  /** The event name this handler responds to. */
  event: string;
  /** The method name on the workflow class. */
  name: string;
  /** Reference to the method itself. */
  handler: (...payload: any[]) => Promise<any>;
}

/**
 * Signature for the fallback handler registered with {@link OnDefault}.
 * Invoked when no transition matches the incoming event.
 */
export type TDefaultHandler<T, Event = string> = <P>(
  entity: T,
  event: Event,
  payload?: P | T | object | string,
) => Promise<T>;
