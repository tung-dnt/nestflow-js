# Interfaces

Core interfaces and types used throughout the workflow library.

## IWorkflowEntity

Interface for entity services that manage workflow entities.

### Signature

```typescript
interface IWorkflowEntity<T = any, State = string | number> {
  create(): Promise<T>;
  load(urn: string | number): Promise<T | null>;
  update(entity: T, status: State): Promise<T>;
  status(entity: T): State;
  urn(entity: T): string | number;
}
```

### Methods

#### `create()`

Creates a new entity instance.

**Returns**: Promise resolving to the new entity.

#### `load(urn)`

Loads an entity by its unique resource name.

**Parameters**:
- `urn`: Unique resource name (entity identifier)

**Returns**: Promise resolving to the entity or null if not found.

#### `update(entity, status)`

Updates an entity's status.

**Parameters**:
- `entity`: The entity to update
- `status`: The new status

**Returns**: Promise resolving to the updated entity.

#### `status(entity)`

Gets the current status of an entity.

**Parameters**:
- `entity`: The entity

**Returns**: The current status.

#### `urn(entity)`

Gets the unique resource name of an entity.

**Parameters**:
- `entity`: The entity

**Returns**: The entity's URN.

### Example

```typescript
@Injectable()
export class OrderEntityService implements IWorkflowEntity<Order, OrderStatus> {
  async create(): Promise<Order> {
    return { id: uuid(), status: OrderStatus.Pending };
  }

  async load(urn: string): Promise<Order | null> {
    return await this.repository.findOne({ where: { id: urn } });
  }

  async update(entity: Order, status: OrderStatus): Promise<Order> {
    entity.status = status;
    return await this.repository.save(entity);
  }

  status(entity: Order): OrderStatus {
    return entity.status;
  }

  urn(entity: Order): string {
    return entity.id;
  }
}
```

## IWorkflowEvent

Interface for workflow events.

### Signature

```typescript
interface IWorkflowEvent<T = any> {
  event: string;        // Event name that triggers a transition
  urn: string | number; // Unique resource name (entity identifier)
  payload?: T | object | string; // Optional event data
  attempt: number;      // Retry attempt number
}
```

### Properties

- `event`: Event name that triggers a transition (e.g., 'order.submit')
- `urn`: Unique resource name identifying the entity
- `payload?`: Optional event payload data
- `attempt`: Current retry attempt number (starts at 0)

### Example

```typescript
const event: IWorkflowEvent = {
  event: 'order.submit',
  urn: 'order-12345',
  payload: {
    items: ['item1', 'item2'],
    total: 150.00,
  },
  attempt: 0,
};
```

## IWorkflowDefinition

Interface for workflow definitions.

### Signature

```typescript
interface IWorkflowDefinition<T, Event, State> {
  name: string;
  states: {
    finals: State[];
    idles: IdleStateEntry<State>[];
    failed: State;
  };
  defaultCallbackTimeout?: Duration;
  transitions: ITransitionEvent<T, Event, State, any>[];
  conditions?: (<P>(entity: T, payload?: P | T | object | string) => boolean)[];
  entityService: string;
}
```

### Properties

- `name`: Unique workflow name
- `states`: State configuration
  - `finals`: Terminal states where the workflow is considered complete
  - `idles`: Idle states (waiting for external events). Each entry can be a bare state value or an object with a per-state callback timeout (see [IdleStateEntry](#idlestateentry))
  - `failed`: Failure state
- `defaultCallbackTimeout?`: Default timeout applied to all idle states that do not specify their own timeout (see [Duration](#duration))
- `transitions`: Array of transition definitions
- `conditions?`: Optional global conditions that must all pass for any transition to proceed
- `entityService`: Injection token for the entity service

### Example

```typescript
const orderWorkflow: IWorkflowDefinition<Order, OrderEvent, OrderStatus> = {
  name: 'order-workflow',
  states: {
    finals: [OrderStatus.Completed, OrderStatus.Cancelled],
    idles: [
      OrderStatus.Pending,
      { state: OrderStatus.AwaitingPayment, timeout: { minutes: 30 } },
    ],
    failed: OrderStatus.Failed,
  },
  defaultCallbackTimeout: { hours: 1 },
  transitions: [
    {
      event: OrderEvent.Submit,
      from: [OrderStatus.Pending],
      to: OrderStatus.Processing,
    },
  ],
  entityService: 'OrderEntityService',
};
```

## ITransitionEvent

Interface for transition event definitions.

### Signature

```typescript
interface ITransitionEvent<T, Event, State = string, P = unknown> {
  event: Event;
  from: State[];
  to: State;
  conditions?: ((entity: T, payload?: P) => boolean)[];
}
```

### Properties

- `event`: Event that triggers the transition
- `from`: Array of source states
- `to`: Target state
- `conditions?`: Optional condition functions (all must return true)

### Example

```typescript
{
  event: 'order.submit',
  from: [OrderStatus.Pending],
  to: OrderStatus.Processing,
  conditions: [
    (entity: Order, payload?: any) => entity.items.length > 0,
    (entity: Order, payload?: any) => entity.totalAmount > 0,
  ],
}
```

## IBackoffRetryConfig

Interface for retry configuration with backoff strategies.

### Signature

```typescript
interface IBackoffRetryConfig {
  handler: string;
  maxAttempts: number;
  strategy?: RetryStrategy;
  initialDelay?: number;
  backoffMultiplier?: number;
  maxDelay?: number;
  jitter?: boolean | number;
}
```

### Properties

- `handler`: Injection token for the retry handler (required)
- `maxAttempts`: Maximum number of retry attempts
- `strategy?`: Backoff strategy from the `RetryStrategy` enum (defaults to `EXPONENTIAL_JITTER`)
- `initialDelay?`: Initial delay in milliseconds (defaults to 1000)
- `backoffMultiplier?`: Multiplier applied to the delay on each retry (defaults to 2)
- `maxDelay?`: Maximum delay cap in milliseconds (defaults to 60000)
- `jitter?`: Jitter configuration. `true` for full jitter, or a number between 0 and 1 for partial jitter

### RetryStrategy Enum

```typescript
enum RetryStrategy {
  FIXED = 'FIXED',
  EXPONENTIAL = 'EXPONENTIAL',
  EXPONENTIAL_JITTER = 'EXPONENTIAL_JITTER', // default
}
```

- `FIXED`: Constant delay between retries (`initialDelay` used every time)
- `EXPONENTIAL`: Delay increases exponentially (`initialDelay * backoffMultiplier^attempt`), capped at `maxDelay`
- `EXPONENTIAL_JITTER`: Exponential backoff with randomized jitter to avoid thundering herd problems

### Example

```typescript
const retryConfig: IBackoffRetryConfig = {
  handler: 'PaymentRetryHandler',
  maxAttempts: 5,
  strategy: RetryStrategy.EXPONENTIAL_JITTER,
  initialDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 30000,
  jitter: true,
};
```

## IdleStateEntry

A type representing an idle state entry in a workflow definition. It can be either a bare state value or an object pairing the state with a per-state callback timeout.

### Signature

```typescript
type IdleStateEntry<State> = State | { state: State; timeout?: Duration };
```

When specified as an object, the `timeout` field overrides the workflow's `defaultCallbackTimeout` for that particular idle state.

### Example

```typescript
const idles: IdleStateEntry<OrderStatus>[] = [
  OrderStatus.Pending,                                          // uses defaultCallbackTimeout
  { state: OrderStatus.AwaitingPayment, timeout: { minutes: 30 } }, // 30-minute timeout
  { state: OrderStatus.AwaitingShipment, timeout: { hours: 2 } },   // 2-hour timeout
];
```

## Duration

A human-readable duration used for timeout configuration. All fields are optional and additive.

### Signature

```typescript
interface Duration {
  hours?: number;
  minutes?: number;
  seconds?: number;
}
```

### Properties

- `hours?`: Number of hours
- `minutes?`: Number of minutes
- `seconds?`: Number of seconds

### Example

```typescript
// 1 hour and 30 minutes
const timeout: Duration = { hours: 1, minutes: 30 };

// 90 seconds
const shortTimeout: Duration = { seconds: 90 };

// 2 hours, 15 minutes, and 30 seconds
const preciseTimeout: Duration = { hours: 2, minutes: 15, seconds: 30 };
```

## PayloadValidator

A user-supplied function that validates a payload against a schema. This type is schema-library agnostic and works with Zod, Joi, class-validator, or any other validation library.

### Signature

```typescript
type PayloadValidator = (schema: unknown, payload: unknown) => unknown;
```

### Parameters

- `schema`: The validation schema (e.g., a Zod schema, Joi schema, or class-validator class)
- `payload`: The payload to validate

**Returns**: The validated (and potentially transformed) payload, or throws on validation failure.

Provided via the `payloadValidator` option in `WorkflowModule.register()`.

### Example

```typescript
import { z } from 'zod';

// Using Zod
const zodValidator: PayloadValidator = (schema, payload) => {
  return (schema as z.ZodSchema).parse(payload);
};

// Using Joi
const joiValidator: PayloadValidator = (schema, payload) => {
  const { value, error } = (schema as Joi.Schema).validate(payload);
  if (error) throw error;
  return value;
};

// Register with the workflow module
WorkflowModule.register({
  workflows: [orderWorkflow],
  payloadValidator: zodValidator,
});
```

## TEither

A true mutually exclusive union type. Unlike a standard `T | U`, this type prevents accidentally mixing properties from both types in a single value.

### Signature

```typescript
type TEither<T, U> = (TWithout<T, U> & U) | (TWithout<U, T> & T);
```

`TWithout<T, U>` marks all keys present in `T` but absent from `U` as `never`, ensuring that when one branch of the union is chosen, properties from the other branch cannot be set.

### Example

```typescript
type CreateAction = { type: 'create'; initialData: object };
type UpdateAction = { type: 'update'; entityId: string };

type Action = TEither<CreateAction, UpdateAction>;

// Valid
const a: Action = { type: 'create', initialData: {} };
const b: Action = { type: 'update', entityId: '123' };

// Type error: cannot mix properties from both types
const c: Action = { type: 'create', initialData: {}, entityId: '123' }; // Error
```

## Related

- [Workflow Module](./workflow-module)
- [Decorators](./decorators)
- [Services](./services)
