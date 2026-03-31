# WorkflowModule

The `WorkflowModule` is the main entry point for registering workflows, entities, and brokers.

## Import

```typescript
import { WorkflowModule } from 'nestflow-js/core';
```

## Static Methods

### `register(options)`

Registers the workflow module with the provided configuration.

#### Parameters

```typescript
WorkflowModule.register({
  imports?: any[];                    // Optional NestJS modules to import
  entities: Provider<IWorkflowEntity>[]; // Entity service providers
  workflows: Provider[];               // Workflow class providers
  payloadValidator?: PayloadValidator;  // Optional schema validation function
  providers?: Provider[];              // Additional providers
})
```

#### Returns

Returns a `DynamicModule` that can be imported into your NestJS module.

#### Example

```typescript
@Module({
  imports: [
    WorkflowModule.register({
      imports: [DatabaseModule],
      entities: [
        { provide: 'entity.order', useClass: OrderEntityService },
      ],
      workflows: [OrderWorkflow],
    }),
  ],
})
export class OrderModule {}
```

## Architecture

```mermaid
graph TB
    A[WorkflowModule] --> B[OrchestratorService]
    A --> C[StateRouterHelperFactory]
    A --> D[Entity Services]
    A --> F[Workflow Classes]
    B --> G[Event Processing]
    B --> H[State Transitions]
    C --> I[Route Resolution]
```

## Exports

The module exports the following services:

- `OrchestratorService` - Main workflow orchestration service
- `StateRouterHelperFactory` - Factory for creating router helpers
- All registered entity services
- All registered workflow classes

## Related

- [OrchestratorService](./services#orchestratorservice)
- [IWorkflowEntity](./interfaces#iworkflowentity)
- [PayloadValidator](./interfaces#payloadvalidator)

