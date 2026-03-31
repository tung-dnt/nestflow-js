# Retry and Error Handling

External APIs fail. Databases time out. Payment processors return transient errors. NestflowJS handles retries so you don't scatter try/catch blocks across your codebase.

## @WithRetry Decorator

Add `@WithRetry` to any `@OnEvent` handler to enable automatic retries with configurable backoff:

```typescript
import { OnEvent, Entity, Payload, WithRetry } from 'nestflow-js/core';
import { RetryStrategy } from 'nestflow-js/core';

@OnEvent('payment.authorized')
@WithRetry({
  handler: 'handleAuthorized',
  maxAttempts: 3,
  strategy: RetryStrategy.EXPONENTIAL_JITTER,
  initialDelay: 500,
  backoffMultiplier: 2,
  maxDelay: 10000,
  jitter: true,
})
async handleAuthorized(@Entity() payment: Payment) {
  const result = await this.paymentGateway.authorize(payment);
  return { authorizationCode: result.code };
}
```

### Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `handler` | `string` | **(required)** | Name of the handler method |
| `maxAttempts` | `number` | **(required)** | Maximum number of attempts (including the initial try) |
| `strategy` | `RetryStrategy` | `EXPONENTIAL_JITTER` | Backoff strategy |
| `initialDelay` | `number` | `1000` | Base delay in milliseconds |
| `backoffMultiplier` | `number` | `2` | Multiplier applied on each attempt |
| `maxDelay` | `number` | `60000` | Upper bound for computed delay in ms |
| `jitter` | `boolean \| number` | `true` | `true` for full jitter, `0–1` for partial jitter percentage |

## Backoff Strategies

NestflowJS supports three retry strategies via the `RetryStrategy` enum:

### `RetryStrategy.FIXED`

Constant delay between attempts. Use when you want predictable timing.

```
Attempt 0: 1000ms
Attempt 1: 1000ms
Attempt 2: 1000ms
```

### `RetryStrategy.EXPONENTIAL`

Delay doubles (or multiplies) on each attempt: `initialDelay * backoffMultiplier^attempt`, capped at `maxDelay`.

```
Attempt 0: 1000ms
Attempt 1: 2000ms
Attempt 2: 4000ms
Attempt 3: 8000ms (capped at maxDelay)
```

### `RetryStrategy.EXPONENTIAL_JITTER` (default)

Exponential backoff with randomized jitter. This is the **AWS-recommended approach** to prevent thundering herd problems when many clients retry simultaneously.

- **Full jitter** (`jitter: true`): `random(0, min(maxDelay, initialDelay * 2^attempt))`
- **Partial jitter** (`jitter: 0.5`): adds ±50% randomization to the exponential delay

## UnretriableException

Some errors should never be retried: invalid input, business rule violations, not-found errors. Throw `UnretriableException` to skip retries immediately:

```typescript
import { UnretriableException } from 'nestflow-js/exception';

@OnEvent('payment.authorized')
@WithRetry({
  handler: 'handleAuthorized',
  maxAttempts: 3,
  strategy: RetryStrategy.EXPONENTIAL,
  initialDelay: 500,
})
async handleAuthorized(@Entity() payment: Payment, @Payload() payload: any) {
  // Permanent failure — don't retry
  if (payload?.cardNumber === '0000-0000-0000-0000') {
    throw new UnretriableException('Invalid card number');
  }

  // Transient failure — will be retried
  const result = await this.paymentGateway.authorize(payment);
  return { authorizationCode: result.code };
}
```

When `UnretriableException` is thrown:
- The entity moves to the workflow's `failed` state
- No further retry attempts are made
- The orchestrator returns `{ status: 'final', state: failedState }`

## Failed State

When a handler throws (and retries are exhausted), the orchestrator automatically:

1. Catches the error
2. Updates the entity to the workflow's configured `failed` state
3. Re-throws the error (so adapters can handle it)

```typescript
@Workflow<Payment, PaymentEvent, PaymentState>({
  name: 'PaymentWorkflow',
  states: {
    finals: [PaymentState.COMPLETED, PaymentState.FAILED],
    idles: [PaymentState.INITIATED],
    failed: PaymentState.FAILED,  // <-- entity moves here on unhandled errors
  },
  // ...
})
```

## Payload Validation

Validate incoming event payloads before your handler executes. NestflowJS is schema-library agnostic — bring your own validation.

### Setup

Provide a `payloadValidator` function when registering the module:

```typescript
import { WorkflowModule } from 'nestflow-js/core';
import { z } from 'zod';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: 'entity.payment', useClass: PaymentEntityService }],
      workflows: [PaymentWorkflow],
      // Zod example
      payloadValidator: (schema, payload) => (schema as z.ZodSchema).parse(payload),
    }),
  ],
})
export class PaymentModule {}
```

### Usage with @Payload

Pass your schema to `@Payload()`:

```typescript
const SubmitPaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
  cardNumber: z.string(),
});

@OnEvent('payment.initiated')
async handleInitiated(
  @Entity() payment: Payment,
  @Payload(SubmitPaymentSchema) data: z.infer<typeof SubmitPaymentSchema>,
) {
  // data is validated and typed
  return { amount: data.amount };
}
```

If validation fails, the framework throws a `BadRequestException` wrapping the validation error.

### Alternative: Joi

```typescript
// In module registration
payloadValidator: (schema, payload) => {
  const { value, error } = (schema as Joi.Schema).validate(payload);
  if (error) throw error;
  return value;
},
```

## RetryBackoff Utility

For custom retry logic outside of `@WithRetry`, use the `RetryBackoff` utility directly:

```typescript
import { RetryBackoff, RetryStrategy } from 'nestflow-js/core';

const delay = RetryBackoff.calculateDelay(attempt, {
  handler: 'myHandler',
  maxAttempts: 5,
  strategy: RetryStrategy.EXPONENTIAL_JITTER,
  initialDelay: 1000,
  backoffMultiplier: 2,
  maxDelay: 30000,
  jitter: true,
});

// Alternative: decorrelated jitter
const nextDelay = RetryBackoff.decorrelatedJitter(previousDelay, 1000, 30000);
```

## Related

- [@WithRetry decorator](../api-reference/decorators#withretry)
- [IBackoffRetryConfig interface](../api-reference/interfaces#ibackoffretryconfig)
- [Payment with Retry example](../examples/payment-with-retry)
- [Adapters](../concepts/adapters) — how adapters consume retry config
