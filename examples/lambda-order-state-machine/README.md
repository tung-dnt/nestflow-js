# Lambda Order State Machine Example

Complete AWS Lambda example demonstrating the `nestflow-js` library with Durable Lambda execution, DynamoDB, and AWS CDK deployment.

## Architecture

```
┌──────────────┐      ┌────────────────────────┐      ┌─────────────────┐
│  Event Source │─────▶│  Durable Lambda Worker │─────▶│ DynamoDB Table  │
│  (Invoke)     │      │  (withDurableExecution) │      │    (Orders)     │
└──────────────┘      └────────────────────────┘      └─────────────────┘
```

## Features

- **CDK Deployment**: Infrastructure as Code with AWS CDK
- **Durable Execution**: Uses `@aws/durable-execution-sdk-js` for reliable, resumable workflow execution
- **State Persistence**: DynamoDB stores orders, transition leases, and event receipts
- **Auto-Scaling**: On-demand DynamoDB and concurrent Lambda execution
- **Monitoring**: CloudWatch logs with 90-day retention

## Installation

Use Node.js 26 at the version pinned in [`.node-version`](../../.node-version) and pnpm 12.23.0. For deployment, install AWS CLI v2 and use an AWS account and region that support Durable Lambda on Node.js 26.

Install dependencies and build the library from the repository root. The example uses `workspace:*` to link to the library in this checkout.

```bash
pnpm install --frozen-lockfile
pnpm build
cd examples/lambda-order-state-machine
```

Run the remaining commands from `examples/lambda-order-state-machine`.

## Configuration

### Environment Variables

Create a `.env` file (optional for local development):

```env
AWS_REGION=us-east-1
DYNAMODB_TABLE=order-state-machine-orders-dev
```

### AWS Credentials

Configure AWS credentials with deployment permissions. Use the same region for CDK and AWS CLI commands:

```bash
aws configure
export AWS_REGION=us-east-1
```

Before deploying to an account and region for the first time, bootstrap CDK:

```bash
pnpm exec cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION"
```

## Running Locally

Start the NestJS application on port 3000:

```bash
pnpm start
```

To exercise order storage with DynamoDB Local, set `DYNAMODB_ENDPOINT` to the local endpoint, set `AWS_REGION`, and use dummy `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values. Create a table with the name in `DYNAMODB_TABLE` and a string partition key named `id`. Leave `DYNAMODB_ENDPOINT` unset to use the normal AWS endpoint.

## Deployment

### Build the Lambda bundle

`pnpm build` type-checks the example with Vite Plus, then bundles the handler and its runtime dependencies into `dist/lambda.mjs`. CDK deploys the contents of `dist`. The local server and the CDK app run directly from TypeScript.

```bash
pnpm build
```

To check that the handler loads without the workspace's `node_modules`, run:

```bash
pnpm run verify:lambda
```

### Preview Changes

```bash
pnpm synth
pnpm diff
```

### Deploy to AWS

```bash
# Deploy to dev stage
pnpm deploy:dev

# Deploy to prod stage
pnpm deploy:prod
```

### Deployment Output

After deployment, you'll see CDK outputs:

```
Outputs:
order-state-machine-dev.FunctionAliasArn = arn:aws:lambda:us-east-1:123456789:function:order-state-machine-dev-order-workflow:live
order-state-machine-dev.TableName = order-state-machine-orders-dev
```

## Monitoring

### View Logs

```bash
aws logs tail /aws/lambda/order-state-machine-dev-order-workflow --follow
```

### CloudWatch Metrics

Monitor in AWS Console:
- Lambda Invocations and Duration
- DynamoDB Read/Write Capacity
- Durable Execution metrics
- Error Rates

## Testing

### Invoke Lambda via AWS CLI

Use the function alias ARN and a [pending order from the quick start](./QUICK_START.md#5-seed-and-process-an-order). Replace `YOUR_ACCOUNT` and `us-east-1` with the account and region from the deployment output. Durable functions must be invoked through a version or alias ARN. Name the execution after the order ID: history and cancellation look the execution up by that name, and Lambda returns the existing execution when the same start is retried.

```bash
aws lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --durable-execution-name 0195146b-1ab7-7dcd-9d26-60eb422f767d \
  --function-name arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:order-state-machine-dev-order-workflow:live \
  --payload '{"urn":"0195146b-1ab7-7dcd-9d26-60eb422f767d","initialEvent":"order.created","eventId":"approve-order-1","payload":{"approved":true}}' \
  output.json
```

## Workflow States

The order workflow transitions through these states:

```
PENDING → PROCESSING → SHIPPED
   │
   └──▶ CANCELLED
   │
   └──▶ FAILED
```

### State Transitions

1. **PENDING**: The order waits for an `order.created` event with `approved: true`.
2. **PROCESSING**: The workflow moves to `order.processing` after approval.
3. **SHIPPED**: The workflow reaches its final state.
4. **FAILED**: A terminal handler failure moves the order to this state.

### Durable claims and receipts

Use a distinct `eventId` for each logical event on an order. Reuse it on redelivery, including when you start a new durable execution for the same event. The Lambda adapter derives stable IDs for later transitions.

The service gives each transition a 60-second lease with a random owner token. It reads the order and receipt together in a DynamoDB transaction before and after the conditional lease update. The commit checks the owner and expiry and writes the updated order and receipt in one transaction. A release removes only its own lease. Direct administrative updates change only status and reject live claims. Use workflow events for read-modify-write business actions.

The lease uses client timestamps. The transaction rejects a prior owner after takeover, but DynamoDB cannot enforce a wall-clock deadline using a caller-supplied time. Keep worker clocks synchronized and use one writable region. Handler work must finish comfortably within the lease or use a storage adapter that renews it. A crash before commit or an expired lease can cause the handler to run again. For external effects, have the downstream service enforce an idempotency key derived from the order ID, `@EventId()`, and the effect name.

Receipt keys use `transition#` and a hash of the order ID and event ID. They do not include either raw ID. Each receipt stores the committed order snapshot, the terminal outcome including the return value on success, and the transition's history entry. Keep handler results JSON-compatible and small. The snapshot, result, entry, and attribute overhead must fit within DynamoDB's 400 KB limit per item. The sample does not expire receipts. Keep them at least as long as events can be redelivered or replayed. Deleting a receipt earlier removes deduplication for that event.

### History and cancellation

`OrderExecutionService` serves the `WORKFLOW_HISTORY` port from the durable execution itself, with no extra table or index. Each `transit:` step checkpoint holds the transition's history entry. `list(orderId, limit, cursor)` reads them with `GetDurableExecutionHistory`, and `cancel(orderId)` calls `StopDurableExecution`; both return cold Observables. Set `ORDER_WORKFLOW_FUNCTION` to the function name or ARN wherever you call them, and grant that caller `lambda:ListDurableExecutionsByFunction`, `lambda:GetDurableExecutionHistory`, and `lambda:StopDurableExecution`. Authorize the order before returning its history.

History lasts as long as the function's durable execution retention, 30 days in this stack. Copy entries elsewhere if you need them longer. `limit` caps durable history events per page, so a page can hold fewer entries. Entries omit event payloads unless the workflow sets `history: { payload: true }`.

## Project Structure

```
lambda-order-state-machine/
├── src/
│   ├── dynamodb/
│   │   ├── client.ts                 # DynamoDB client
│   │   └── order.table.ts            # Order table definition
│   ├── order/
│   │   ├── order.constant.ts         # Constants and enums
│   │   ├── order.module.ts           # NestJS module
│   │   ├── order.workflow.ts         # Workflow definition
│   │   ├── order-entity.service.ts   # Entity service
│   │   └── order-execution.service.ts # Durable history and cancellation
│   ├── lambda.ts                     # Durable Lambda handler
│   └── main.ts                       # Local entry point
├── infra/
│   └── order-stack.ts                # CDK stack definition
├── dist/                             # Compiled JavaScript
├── cdk.json                          # CDK app config
├── package.json
├── tsconfig.json
└── README.md
```

## Stack Details

### AWS Resources Created

1. **Lambda Function (Durable)**
   - Runtime: Node.js 26.x
   - Memory: 512 MB
   - Timeout: 15 minutes
   - Durable execution timeout: 1 hour
   - Checkpoint retention: 30 days
   - Wrapped with `withDurableExecution` for automatic replay and fault tolerance

2. **DynamoDB Table (Orders and Transition Receipts)**
   - Billing: On-demand (PAY_PER_REQUEST)
   - Partition key: `id` (string)

3. **Durable Execution Store**
   - Managed by `@aws/durable-execution-sdk-js`
   - Stores execution history for replay on Lambda restarts

### IAM Permissions

The Lambda function has permissions for:
- DynamoDB: Full read/write access to the orders table
- Durable execution: `AWSLambdaBasicDurableExecutionRolePolicy`

## Cost Estimation

**Development (dev stage)**:
- Lambda: ~$0.01 - $1.00/month (depending on usage)
- DynamoDB: Free tier (25 GB storage, 25 RCU/WCU)

**Production (prod stage)**:
- Scales with usage, typically $10-100/month for moderate traffic

## Advanced Features

### Durable Execution

The `withDurableExecution` wrapper checkpoints completed steps. Replay can resume from their stored results. The DynamoDB receipt handles the gap between a transaction commit and a durable checkpoint.

### Lambda Handler

```typescript
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { NestFactory } from "@nestjs/core";
import { DurableLambdaEventHandler } from "nestflow-js/adapter";
import { OrderModule } from "./order/order.module.js";

const app = await NestFactory.createApplicationContext(OrderModule);
await app.init();

export const handler = DurableLambdaEventHandler(app, withDurableExecution);
```

### Module Registration

```typescript
WorkflowModule.register({
  entities: [{ provide: ORDER_WORKFLOW_ENTITY, useClass: OrderEntityService }],
  workflows: [OrderWorkflow],
})
```

## Troubleshooting

### Deployment Issues

**Issue**: `The security token included in the request is invalid`
**Solution**: Check AWS credentials with `aws sts get-caller-identity`

**Issue**: `CDKToolkit stack not found`
**Solution**: Follow the [CDK bootstrap step](./QUICK_START.md#3-bootstrap-cdk).

### Runtime Issues

**Issue**: Lambda timeout
**Solution**: Check workflow logic for long-running operations

**Issue**: Workflow not progressing
**Solution**:
1. Check Lambda CloudWatch logs
2. Verify IAM permissions
3. Check DynamoDB table exists
4. Verify durable execution store is accessible

## Cleanup

Remove the dev stack. This deletes the table, including its orders and receipts.

```bash
pnpm destroy
```

This will delete:
- Lambda function
- DynamoDB table
- IAM roles
- CloudWatch log groups

## Learn More

- [nestflow-js Documentation](../../docs/)
- [AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/)
- [AWS Lambda Durable Execution](https://docs.aws.amazon.com/lambda/latest/dg/durable-getting-started-iac.html)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [AWS Durable Execution SDK](https://github.com/aws/durable-execution-sdk-js)
- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)

## License

MIT
