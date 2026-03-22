# Lambda Order State Machine Example

Complete AWS Lambda example demonstrating the `nestjs-serverless-workflow` library with Durable Lambda execution, DynamoDB, and serverless deployment.

## Architecture

```
┌──────────────┐      ┌────────────────────────┐      ┌─────────────────┐
│  Event Source │─────▶│  Durable Lambda Worker │─────▶│ DynamoDB Table  │
│  (Invoke)     │      │  (withDurableExecution) │      │    (Orders)     │
└──────────────┘      └────────────────────────┘      └─────────────────┘
```

## Features

- **Serverless Deployment**: Fully configured AWS Lambda with Serverless Framework
- **Durable Execution**: Uses `@aws/durable-execution-sdk-js` for reliable, resumable workflow execution
- **State Persistence**: DynamoDB for order storage
- **Auto-Scaling**: On-demand DynamoDB and concurrent Lambda execution
- **Monitoring**: CloudWatch logs with 90-day retention

## Installation

```bash
cd examples/lambda-order-state-machine
bun install
```

## Configuration

### Environment Variables

Create a `.env` file (optional for local development):

```env
AWS_REGION=us-east-1
STAGE=dev
DYNAMODB_TABLE=lambda-order-state-machine-orders-dev
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

## Deployment

### Build TypeScript

```bash
bun run build
```

### Deploy to AWS

```bash
# Deploy to dev stage
bun run deploy:dev

# Deploy to prod stage
bun run deploy:prod

# Or specify region and stage
serverless deploy --stage prod --region us-west-2
```

### Deployment Output

After deployment, you'll see:

```
Service Information
service: lambda-order-state-machine
stage: dev
region: us-east-1
stack: lambda-order-state-machine-dev

functions:
  order-workflow: lambda-order-state-machine-dev-order-workflow
```

## Monitoring

### View Logs

```bash
# Tail logs in real-time
bun run logs

# Or with serverless directly
serverless logs -f order-workflow -t --stage dev
```

### CloudWatch Metrics

Monitor in AWS Console:
- Lambda Invocations and Duration
- DynamoDB Read/Write Capacity
- Durable Execution metrics
- Error Rates

## Testing

### Invoke Lambda Directly

```bash
serverless invoke -f order-workflow \
  --data '{"urn":"order-123","event":"order.submit","payload":{"items":["item1"],"totalAmount":100}}'
```

### Invoke via AWS CLI

```bash
aws lambda invoke \
  --function-name lambda-order-state-machine-dev-order-workflow \
  --payload '{"urn":"order-123","event":"order.submit","payload":{"items":["item1"],"totalAmount":100}}' \
  output.json
```

## Workflow States

The order workflow transitions through these states:

```
PENDING → PROCESSING → COMPLETED
   │
   └──▶ CANCELLED
   │
   └──▶ FAILED
```

### State Transitions

1. **PENDING**: Order created
2. **PROCESSING**: Order being processed (triggered by `order.submit`)
3. **COMPLETED**: Order successfully completed (triggered by `order.complete`)
4. **CANCELLED**: Order cancelled (manual)
5. **FAILED**: Order failed (on error)

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
├── dist/                             # Compiled JavaScript
├── package.json
├── serverless.yml                    # Serverless config
├── tsconfig.json
└── README.md
```

## Stack Details

### AWS Resources Created

1. **Lambda Function (Durable)**
   - Runtime: Node.js 20.x
   - Memory: 512 MB
   - Timeout: 15 minutes
   - Wrapped with `withDurableExecution` for automatic replay and fault tolerance

2. **DynamoDB Table**
   - Billing: On-demand
   - Point-in-time recovery: Enabled
   - Stream: Enabled (NEW_AND_OLD_IMAGES)
   - GSI: status-index

3. **Durable Execution Store**
   - Managed by `@aws/durable-execution-sdk-js`
   - Stores execution history for replay on Lambda restarts

### IAM Permissions

The Lambda function has permissions for:
- DynamoDB: GetItem, PutItem, UpdateItem, Query, Scan

## Cost Estimation

**Development (dev stage)**:
- Lambda: ~$0.01 - $1.00/month (depending on usage)
- DynamoDB: Free tier (25 GB storage, 25 RCU/WCU)

**Production (prod stage)**:
- Scales with usage, typically $10-100/month for moderate traffic

## Advanced Features

### Durable Execution

The Lambda handler is wrapped with `withDurableExecution`, which provides:
- **Automatic Replay**: If the Lambda is interrupted, execution resumes from the last checkpoint
- **Fault Tolerance**: Transient failures are handled transparently
- **Deterministic Execution**: Side effects are recorded and replayed consistently

### Lambda Handler

```typescript
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { NestFactory } from "@nestjs/core";
import { DurableLambdaEventHandler } from "nestjs-serverless-workflow/adapter";
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

### Runtime Issues

**Issue**: Lambda timeout
**Solution**: Increase timeout in `serverless.yml` or optimize workflow logic

**Issue**: Workflow not progressing
**Solution**:
1. Check Lambda CloudWatch logs
2. Verify IAM permissions
3. Check DynamoDB table exists
4. Verify durable execution store is accessible

## Cleanup

Remove all AWS resources:

```bash
serverless remove --stage dev
```

This will delete:
- Lambda function
- DynamoDB table
- IAM roles
- CloudWatch log groups

## Learn More

- [nestjs-serverless-workflow Documentation](../../docs/)
- [Serverless Framework Docs](https://www.serverless.com/framework/docs)
- [AWS Lambda Best Practices](https://docs.aws.amazon.com/lambda/latest/dg/best-practices.html)
- [AWS Durable Execution SDK](https://github.com/aws/durable-execution-sdk-js)
- [DynamoDB Best Practices](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html)

## License

MIT
