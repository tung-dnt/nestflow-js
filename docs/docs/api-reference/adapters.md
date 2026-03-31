# Adapters

Adapters integrate the workflow engine with different runtime environments.

## DurableLambdaEventHandler

Factory function that creates a durable Lambda handler for long-running workflows with checkpoint/replay.

### Import

```typescript
import { DurableLambdaEventHandler } from 'nestflow-js/adapter';
```

### Signature

```typescript
DurableLambdaEventHandler(
  app: INestApplicationContext,
  withDurableExecution: WithDurableExecution,
): (event: DurableWorkflowEvent, ctx: IDurableContext) => Promise<DurableWorkflowResult>
```

### Parameters

- `app`: NestJS application context containing the workflow module
- `withDurableExecution`: The `withDurableExecution` function from `@aws/durable-execution-sdk-js`

### Example

```typescript
import { NestFactory } from '@nestjs/core';
import { DurableLambdaEventHandler } from 'nestflow-js/adapter';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { AppModule } from './app.module';

const app = await NestFactory.createApplicationContext(AppModule);
export const handler = DurableLambdaEventHandler(app, withDurableExecution);
```

### Features

- **Checkpoint/Replay**: Steps are checkpointed at event boundaries — on replay, completed steps return stored results
- **Idle State Callbacks**: Pauses via `waitForCallback()` when workflow reaches an idle state
- **Retry with Backoff**: Respects `@WithRetry()` configuration with durable waits between attempts
- **Configurable Timeout**: `idle` and `no_transition` states support a `timeout` field (default: 24 hours)

See [Adapters concept guide](../concepts/adapters) for detailed usage.

## Creating Custom Adapters

You can create adapters for other runtimes by using the `OrchestratorService` directly.

### HTTP Adapter Example

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { OrchestratorService } from 'nestflow-js/core';
import type { IWorkflowEvent } from 'nestflow-js/core';

@Controller('workflow')
export class WorkflowController {
  constructor(private orchestrator: OrchestratorService) {}

  @Post('events')
  async handleEvent(@Body() event: IWorkflowEvent) {
    await this.orchestrator.transit(event);
    return { status: 'processed' };
  }
}
```

### EventBridge Adapter Example

```typescript
import { EventBridgeHandler } from 'aws-lambda';
import { OrchestratorService } from 'nestflow-js/core';

export const handler: EventBridgeHandler<string, any, void> = async (event) => {
  const app = await getApp();
  const orchestrator = app.get(OrchestratorService);

  const workflowEvent = {
    event: event['detail-type'],
    urn: event.detail.entityId,
    payload: event.detail,
    attempt: 0,
  };

  await orchestrator.transit(workflowEvent);
};
```

## BaseWorkflowAdapter

Custom adapters can extend the `BaseWorkflowAdapter` abstract class to get a consistent foundation for integrating with the workflow engine. This base class provides the core wiring needed to resolve the `OrchestratorService` from the NestJS application context and dispatch events.

## Related

- [Adapters Guide](../concepts/adapters)
- [OrchestratorService](./services#orchestratorservice)
- [IWorkflowEvent](./interfaces#iworkflowevent)
