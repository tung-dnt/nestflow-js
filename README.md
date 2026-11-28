# Introduction

[![npm version](https://img.shields.io/npm/v/nestflow-js.svg)](https://www.npmjs.com/package/nestflow-js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Define business state and transitions. Keep your entities in a storage backend that supports atomic claims and commits.

## Features

- 🎯 **State Machine Engine**: Define workflows with states, transitions, and events
- **Runtime adapters**: Run the same workflow in a Node service, a RabbitMQ worker, AWS Durable Lambda, Azure Functions with Service Bus, or Cloud Run with Pub/Sub.
- 🔄 **Durable Execution**: Checkpoint and replay workflows across Lambda invocations using AWS Durable Functions
- 📦 **Tree-Shakable**: Subpath exports ensure minimal bundle sizes
- 🛡️ **Type-Safe**: Full TypeScript support with comprehensive type definitions
- **Handler retries**: Configure retry attempts and backoff with `@WithRetry`.
- 🎨 **Decorator-Based API**: Clean, declarative workflow definitions

## Installation

This version requires NestJS 12 and Node.js 22.12 or later. See the [NestJS 12 migration guide](https://docs.nestjs.com/migration-guide).

```bash
pnpm add nestflow-js @nestjs/common@12 @nestjs/core@12 class-transformer@^0.5.1 class-validator@^0.14.2 reflect-metadata@^0.2.0 rxjs@^7.8.0
```

The TypeScript examples use ESM (`"type": "module"` in `package.json` and `"module": "NodeNext"` in `tsconfig.json`). Enable `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig.json`.

## Quick Start

### 1. Define Your Entity

Create `order.ts`:

```typescript
export enum OrderStatus {
  Pending = 'pending',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
}

export interface Order {
	id: string;
	status: OrderStatus;
}
```

### 2. Create a Workflow

Create `order.workflow.ts`:

```typescript
import { Workflow, OnEvent, Entity } from 'nestflow-js/core';
import { OrderStatus, type Order } from './order.js';

@Workflow({
  name: 'OrderWorkflow',
  states: {
    finals: [OrderStatus.Completed, OrderStatus.Failed],
    idles: [OrderStatus.Pending],
    failed: OrderStatus.Failed,
  },
  transitions: [
    {
      from: [OrderStatus.Pending],
      to: OrderStatus.Processing,
      event: 'order.submit',
    },
    {
      from: [OrderStatus.Processing],
      to: OrderStatus.Completed,
      event: 'order.complete',
    },
  ],
  entityService: 'entity.order',
})
export class OrderWorkflow {
	@OnEvent('order.submit')
	async onSubmit(@Entity() order: Order) {
		return { orderId: order.id };
	}

	@OnEvent('order.complete')
	async onComplete(@Entity() order: Order) {
		return { orderId: order.id };
	}
}
```

### 3. Implement the entity service

Implement [`IWorkflowEntity`](https://tung-dnt.github.io/nestflow-js/docs/api-reference/interfaces#iworkflowentity) for your storage backend. The orchestrator calls `claimTransition(urn, eventId)` to obtain an exclusive claim or recover a committed receipt. Use the [DynamoDB entity service](examples/lambda-order-state-machine/src/order/order-entity.service.ts) as a working reference.

### 4. Register the Module

Create `order.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { WorkflowModule } from 'nestflow-js/core';
import { OrderWorkflow } from './order.workflow.js';
import { OrderEntityService } from './order-entity.service.js';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: 'entity.order', useClass: OrderEntityService }],
      workflows: [OrderWorkflow],
    }),
  ],
})
export class OrderModule {}
```

To validate `@Payload(schema)`, install the plugin for your schema library and register its exported function as `payloadValidator`. For example, install `@nestflow-js/validator-zod` and `zod`, then set `payloadValidator: zodPayloadValidator`. See the [four validator plugins](docs/content/docs/api-reference/interfaces.mdx#payloadvalidator).

## Migrating to transition claims

This is a breaking change. Upgrade event producers and entity services together.

1. Implement `claimTransition(urn, eventId)`. Commit the entity state and receipt atomically, under the current lease token. Do not implement claims by calling `load()` and `update()` separately.
2. Supply a non-empty `eventId` for every `IWorkflowEvent` and initial `DurableWorkflowEvent`. Keep it unchanged across retries and redeliveries. Never use the same ID for different events on the same entity. Durable callback bodies still contain `{ event, payload }`. The adapter derives their IDs.
3. Requeue a busy event with the same ID after backoff. The orchestrator raises `ConflictException` (HTTP 409). The Durable Lambda adapter does not treat a conflict, validation error, guard error, storage error, or post-commit error as a handler retry.
4. Keep guards pure. Persist only serializable entity snapshots and handler output that are safe to store. Use `@EventId()` with the entity ID to deduplicate downstream side effects. A crash before commit can rerun the handler after the lease expires. Receipts deduplicate committed transitions and do not guarantee exactly-once side effects.
5. Await `firstValueFrom(orchestrator.transit(event))` for a single attempt. A retry-aware custom adapter subscribes to `transitAttempt(event, canRetry)` and schedules another attempt only if it emits `{ status: 'retry' }`.

Before you deploy the Durable Lambda replay changes, drain executions started on the old adapter or use versioning to keep them on that adapter until they finish. Do not replay their checkpoints with the new adapter.

## Documentation

📚 **[Full Documentation](https://tung-dnt.github.io/nestflow-js/)**

- [Quick Start](https://tung-dnt.github.io/nestflow-js/docs/quick-start)
- [Choose a deployment architecture](https://nestflow.organit.dev/docs/deployment-architecture)
- [Workflow Definition](https://tung-dnt.github.io/nestflow-js/docs/concepts/workflow-definition)
- [Durable Lambda Adapter](https://tung-dnt.github.io/nestflow-js/docs/plugins/durable-lambda)
- [API Reference](https://tung-dnt.github.io/nestflow-js/docs/api-reference/workflow-module)
- [Examples](https://tung-dnt.github.io/nestflow-js/docs/examples/lambda-order-state-machine)

## Package Structure

The library is organized into tree-shakable subpath exports:

```
nestflow-js/
├── core          # Core workflow engine (decorators, services, types, IWorkflowEvent)
├── adapter       # In-process, broker, and Durable Lambda adapters
└── exception     # Custom exception types
```

### Import Only What You Need

```typescript
// Core workflow engine
import { WorkflowModule, type IWorkflowEvent } from 'nestflow-js/core';

// Choose the execution model for your deployment.
import { runInProcess, processWorkflowMessage, DurableLambdaEventHandler } from 'nestflow-js/adapter';

// Exceptions
import { UnretriableException } from 'nestflow-js/exception';
```

This ensures minimal bundle sizes and faster cold starts in serverless environments.

## Transit Result

`transit()` returns a cold RxJS Observable. Each subscription starts an attempt and emits one of these results on success. Unsubscribing does not cancel a running attempt.

```typescript
type TransitResult =
  | { status: 'final'; state: string | number }
  | { status: 'idle'; state: string | number; timeout?: Duration }
  | { status: 'continued'; nextEvent: IWorkflowEvent }
  | { status: 'no_transition'; state: string | number; timeout?: Duration };
```

- **`final`** -- the workflow has reached a terminal state.
- **`idle`** -- the workflow is waiting for an external event.
- **`continued`** -- the workflow auto-transitioned and provides the next event to process.
- `no_transition` means there is no unambiguous automatic continuation.

## Custom Adapters

Extend `BaseWorkflowAdapter` to dispatch `TransitResult` variants in a loop. Implement `executeTransit()` for your runtime and return the orchestrator's `nextEvent` unchanged when the result is `continued`. See the [adapter reference](https://tung-dnt.github.io/nestflow-js/docs/api-reference/adapters) for hook signatures and retry rules.

## Examples

Check out the [examples directory](https://github.com/tung-dnt/nestflow-js/tree/main/examples) for complete working examples:

- [Broker workflow](examples/broker-workflow): One PostgreSQL-backed workflow with RabbitMQ, Azure Service Bus, and Google Cloud Pub/Sub bindings.
- **[Lambda Order State Machine](https://github.com/tung-dnt/nestflow-js/tree/main/examples/lambda-order-state-machine/)**: Complete AWS Lambda example with DynamoDB and durable execution

## Key Concepts

### States

States represent the different stages your entity can be in:

- **Finals**: Terminal states where the workflow ends
- **Idles**: States where the workflow waits for external events
- **Failed**: The state committed after an unretriable handler error or after the last handler attempt fails

### Transitions

Transitions define how entities move from one state to another, triggered by events:

```typescript
{
	from: [OrderStatus.Pending],
	to: OrderStatus.Processing,
	event: 'order.submit',
	conditions: [
		(entity: Order, payload?: { approved: boolean }) => payload?.approved === true,
	],
}
```

### Events

Events trigger state transitions. Pass an [`IWorkflowEvent`](https://tung-dnt.github.io/nestflow-js/docs/api-reference/interfaces#iworkflowevent) to the orchestrator:

```typescript
import type { IWorkflowEvent } from 'nestflow-js/core';

const event: IWorkflowEvent = {
	event: 'order.submit',
	urn: 'order-123',
	eventId: 'submit-command-456',
	attempt: 0,
};
```

In production, use the ID of the logical command or delivery instead of a constant. Give each distinct event on the entity its own ID.

## AWS Lambda Integration

The built-in `DurableLambdaEventHandler` runs the workflow across Lambda invocations with [AWS Lambda Durable Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html).

- Completed Durable steps return their checkpointed results on replay.
- Idle states wait for an external event through `waitForCallback()`.
- A final result ends the execution.

Send `{ urn, initialEvent, eventId, payload? }` to start an execution. The adapter does not use SDK automatic retries for transit steps. It schedules another attempt only when the orchestrator returns `{ status: 'retry' }`.

Install the AWS Durable Execution SDK before building the handler:

```bash
pnpm add @aws/durable-execution-sdk-js
```

```typescript
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { NestFactory } from '@nestjs/core';
import { DurableLambdaEventHandler } from 'nestflow-js/adapter';
import { OrderModule } from './order.module.js';

const app = await NestFactory.createApplicationContext(OrderModule);
await app.init();

export const handler = DurableLambdaEventHandler(app, withDurableExecution);
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](https://github.com/tung-dnt/nestflow-js/tree/main/CONTRIBUTING.md) for details on:

- Code style and conventions
- Development setup
- Testing guidelines
- Pull request process

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/tung-dnt/nestflow-js/tree/main/LICENSE) file for details.

## Author

**Thomas Do (tung-dnt)**

- GitHub: [@tung-dnt](https://github.com/tung-dnt)
- Repository: [nestflow-js](https://github.com/tung-dnt/nestflow-js)

## Support

- 📖 [Documentation](https://tung-dnt.github.io/nestflow-js/)
- 🐛 [Issue Tracker](https://github.com/tung-dnt/nestflow-js/issues)
- 💬 [Discussions](https://github.com/tung-dnt/nestflow-js/discussions)

## Related Projects

- [NestJS](https://nestjs.com/) - A progressive Node.js framework
- [AWS Lambda](https://aws.amazon.com/lambda/) - Serverless compute service
- [AWS Lambda Durable Functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) - Durable execution for Lambda
