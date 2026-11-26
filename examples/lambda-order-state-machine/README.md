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

Use Node.js 22.12 or later and NestJS 12. The build emits `dist/lambda.mjs`, so Lambda can load the handler without experimental module flags.

Run these commands from the repository root. The example uses `file:../..` to install the library from this checkout, not the published package. Build the library before installing the example dependencies.

```bash
bun install
bun run build
cd examples/lambda-order-state-machine
bun install
```

## Configuration

### Environment Variables

Create a `.env` file (optional for local development):

```env
AWS_REGION=us-east-1
DYNAMODB_TABLE=order-state-machine-orders-dev
```

### AWS Credentials

Ensure AWS credentials are configured:

```bash
aws configure
```

Or set environment variables:

```bash
export AWS_ACCESS_KEY_ID=your_access_key
export AWS_SECRET_ACCESS_KEY=your_secret_key
export AWS_REGION=us-east-1
```

## Running Locally

### Start the Application

```bash
bun run start
# or
bun run start:dev  # with hot reload
```

To exercise order storage with DynamoDB Local, set `DYNAMODB_ENDPOINT` to the local endpoint, set `AWS_REGION`, and use dummy `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values. Create a table with the name in `DYNAMODB_TABLE` and a string partition key named `id`. Leave `DYNAMODB_ENDPOINT` unset to use the normal AWS endpoint.

## Deployment

### Build the Lambda bundle

```bash
bun run typecheck
bun run build
```

### Preview Changes

```bash
bun run diff
```

### Deploy to AWS

```bash
# Deploy to dev stage
bun run deploy:dev

# Deploy to prod stage
bun run deploy:prod

# Or specify stage via CDK context
bunx cdk deploy -c stage=prod -c region=us-west-2
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

Use the function alias ARN and a [pending order from the quick start](./QUICK_START.md#5-seed-and-process-an-order). Durable functions must be invoked through a version or alias ARN.

```bash
aws lambda invoke \
  --cli-binary-format raw-in-base64-out \
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

Receipt keys use `transition#` and a hash of the order ID and event ID. They do not include either raw ID. Each receipt stores the committed order snapshot and terminal outcome, including the return value on success. Keep handler results JSON-compatible and small. The snapshot, result, and attribute overhead must fit within DynamoDB's 400 KB limit per item. The sample does not expire receipts. Keep them at least as long as events can be redelivered or replayed. Deleting a receipt earlier removes deduplication for that event.

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
│   │   └── order-entity.service.ts   # Entity service
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
   - Runtime: Node.js 22.x
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
import { OrderModule } from "./order/order.module";

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
**Solution**: Bootstrap CDK with `bunx cdk bootstrap`

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

Remove all AWS resources:

```bash
bun run destroy
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
