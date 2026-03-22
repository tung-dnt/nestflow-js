# Adapters & TransitResult

Adapters consume the `TransitResult` returned by `OrchestratorService.transit()` and decide how to drive the workflow forward. The library ships with a durable Lambda adapter and exposes the interfaces needed to build your own.

## Core Concepts

### Workflow Events

Events trigger workflow transitions. The `IWorkflowEvent` interface lives in `nestjs-serverless-workflow/core`:

```typescript
import type { IWorkflowEvent } from 'nestjs-serverless-workflow/core';

// Shape of a workflow event
interface IWorkflowEvent<T = any> {
  event: string;           // Event name that triggers a transition
  urn: string | number;    // Unique identifier for the entity
  payload?: T | object | string; // Optional event data
  attempt: number;         // Retry attempt number
}
```

### TransitResult

Every call to `orchestrator.transit(event)` returns a `TransitResult`:

```typescript
type TransitResult =
  | { status: 'final'; state: string | number }
  | { status: 'idle'; state: string | number }
  | { status: 'continued'; nextEvent: IWorkflowEvent }
  | { status: 'no_transition'; state: string | number };
```

Adapters read this result and react accordingly:

| Status | Adapter action |
|--------|---------------|
| `final` | Workflow is done — return the result. |
| `idle` | Wait for an external event (e.g., a callback). |
| `continued` | Feed `nextEvent` back into `transit()` to continue processing. |
| `no_transition` | No unambiguous auto-transition — wait for an explicit event. |

## DurableLambdaEventHandler

The built-in adapter for AWS Lambda with the Durable Execution SDK. It runs the entire workflow lifecycle inside a single durable execution, checkpointing at each step.

### Setup

```typescript
import { NestFactory } from '@nestjs/core';
import { DurableLambdaEventHandler } from 'nestjs-serverless-workflow/adapter';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { AppModule } from './app.module';

const app = await NestFactory.createApplicationContext(AppModule);
export const handler = DurableLambdaEventHandler(app, withDurableExecution);
```

### How It Works

The adapter loops over `transit()` calls, reacting to each `TransitResult`:

1. **`continued`** — Checkpoints the next event via `ctx.step()`, then calls `transit()` again with `nextEvent`.
2. **`idle`** — Pauses via `ctx.waitForCallback()`. An external system resumes the workflow by calling the Lambda `SendDurableExecutionCallbackSuccess` API.
3. **`no_transition`** — Also pauses via `ctx.waitForCallback()`, waiting for an explicit event from an external system.
4. **`final`** — Returns the completed result, ending the durable execution.

### Event Shape

The durable adapter expects a `DurableWorkflowEvent`:

```typescript
interface DurableWorkflowEvent {
  urn: string | number;
  initialEvent: string;
  payload?: any;
}
```

And returns a `DurableWorkflowResult`:

```typescript
interface DurableWorkflowResult {
  urn: string | number;
  status: string;
  state: string | number;
}
```

## IDurableContext

The `IDurableContext` interface abstracts the durable execution runtime. The real implementation comes from `@aws/durable-execution-sdk-js`, but the interface is exported so you can mock it in tests.

```typescript
import type { IDurableContext } from 'nestjs-serverless-workflow/adapter';

interface IDurableContext {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  waitForCallback<T>(
    name: string,
    onRegister: (callbackId: string) => Promise<void>,
    options?: { timeout?: { hours?: number; minutes?: number; seconds?: number } },
  ): Promise<T>;
  wait(duration: { seconds?: number; minutes?: number; hours?: number }): Promise<void>;
  logger: { info(msg: string, data?: any): void };
}
```

## Testing with MockDurableContext

For tests, use a mock context that simulates checkpoint/replay and callbacks:

```typescript
import { Test } from '@nestjs/testing';
import { WorkflowModule } from 'nestjs-serverless-workflow/core';
import { DurableLambdaEventHandler } from 'nestjs-serverless-workflow/adapter';
import type { DurableWorkflowEvent, DurableWorkflowResult, IDurableContext } from 'nestjs-serverless-workflow/adapter';

// A minimal mock context for testing
class MockDurableContext implements IDurableContext {
  private steps = new Map<string, any>();
  private callbacks = new Map<string, { resolve: (value: any) => void }>();

  logger = { info: (_msg: string, _data?: any) => {} };

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.steps.has(name)) return this.steps.get(name);
    const result = await fn();
    this.steps.set(name, result);
    return result;
  }

  async waitForCallback<T>(
    name: string,
    onRegister: (callbackId: string) => Promise<void>,
  ): Promise<T> {
    const callbackId = `callback:${name}`;
    let resolve: (value: any) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    this.callbacks.set(callbackId, { resolve: resolve! });
    await onRegister(callbackId);
    return promise;
  }

  async wait(): Promise<void> {}

  /** Submit a callback to resume the workflow — simulates an external system. */
  submitCallback(name: string, payload: any): void {
    const entry = this.callbacks.get(`callback:${name}`);
    if (!entry) throw new Error(`No callback registered for: callback:${name}`);
    entry.resolve(payload);
  }
}

// Mock withDurableExecution — passes through to the raw handler
const mockWithDurableExecution = (handler) => handler as any;

// Usage in a test
const module = await Test.createTestingModule({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: 'entity.order', useValue: new OrderEntityService() }],
      workflows: [OrderWorkflow],
    }),
  ],
}).compile();

const app = module.createNestApplication();
await app.init();

const handler = DurableLambdaEventHandler(app, mockWithDurableExecution);
const ctx = new MockDurableContext();

// Start the workflow
const resultPromise = handler(
  { urn: 'order-1', initialEvent: 'order.created', payload: {} },
  ctx,
);

// When the adapter reaches an idle or no_transition state, submit a callback:
ctx.submitCallback('idle:pending:0', { event: 'order.submit', payload: {} });

const result = await resultPromise;
```

## Creating Custom Adapters

Any adapter simply calls `orchestrator.transit()` and reacts to the returned `TransitResult`. Here is a minimal example that processes continued transitions in a loop:

```typescript
import { OrchestratorService } from 'nestjs-serverless-workflow/core';
import type { IWorkflowEvent, TransitResult } from 'nestjs-serverless-workflow/core';

async function runWorkflow(
  orchestrator: OrchestratorService,
  initialEvent: IWorkflowEvent,
): Promise<TransitResult> {
  let currentEvent = initialEvent;

  while (true) {
    const result = await orchestrator.transit(currentEvent);

    switch (result.status) {
      case 'final':
        return result;

      case 'idle':
        // Your adapter decides how to wait — poll a queue, wait for a webhook, etc.
        return result;

      case 'continued':
        // Feed the next event back into transit
        currentEvent = result.nextEvent;
        break;

      case 'no_transition':
        // No auto-transition available — return and let the caller decide
        return result;
    }
  }
}
```

The key principle: the orchestrator is responsible for state transitions and business logic. The adapter is responsible for infrastructure concerns like checkpointing, waiting for callbacks, and retry.

## Related Documentation

- [Workflow Module](./workflow) - Define workflows and understand TransitResult
- [Lambda Adapter](./adapters) - Deploy your workflows to AWS Lambda
