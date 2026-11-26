# Quick Start Guide

Deploy the order workflow and process a pending order with Durable Lambda.

## Prerequisites

- Node.js 26 at the version pinned in [`.node-version`](../../.node-version).
- pnpm 12.23.0.
- AWS CLI v2 and credentials with permission to bootstrap and deploy with AWS CDK.
- An AWS region that supports Durable Lambda on Node.js 26.

## Deploy and invoke

### 1. Install dependencies and build the library

Run these commands from the repository root. The example links to the library in this checkout through the workspace.

```bash
pnpm install --frozen-lockfile
pnpm build
cd examples/lambda-order-state-machine
```

Run the remaining commands from `examples/lambda-order-state-machine`.

### 2. Configure AWS

Configure credentials if you have not done so. Set the region for CDK and the AWS CLI:

```bash
aws configure
export AWS_REGION=us-east-1
```

### 3. Bootstrap CDK

Run this once per AWS account and region:

```bash
pnpm exec cdk bootstrap "aws://$(aws sts get-caller-identity --query Account --output text)/$AWS_REGION"
```

### 4. Deploy the dev stack

```bash
pnpm deploy:dev
```

### 5. Seed and process an order

Use the table name and function alias ARN from the deployment output. Seed a pending order without overwriting an existing row:

```bash
aws dynamodb put-item \
  --table-name order-state-machine-orders-dev \
  --condition-expression 'attribute_not_exists(id)' \
  --item '{"id":{"S":"0195146b-1ab7-7dcd-9d26-60eb422f767d"},"item":{"S":"laptop"},"quantity":{"N":"1"},"price":{"N":"999"},"status":{"S":"pending"}}'
```

Invoke the Lambda with the order ID and a stable `eventId`. Replace `YOUR_ACCOUNT` and `us-east-1` using the `FunctionAliasArn` from the deployment output. Reuse the event ID when you retry the same request.

```bash
aws lambda invoke \
  --cli-binary-format raw-in-base64-out \
  --function-name arn:aws:lambda:us-east-1:YOUR_ACCOUNT:function:order-state-machine-dev-order-workflow:live \
  --payload '{"urn":"0195146b-1ab7-7dcd-9d26-60eb422f767d","initialEvent":"order.created","eventId":"approve-order-1","payload":{"approved":true}}' \
  response.json
```

The execution moves the order to `shipped`. Watch the logs:

```bash
aws logs tail /aws/lambda/order-state-machine-dev-order-workflow --follow
```

## What You Get

After deployment, you'll have:

- **Durable Lambda Function** - Processes orders with fault-tolerant execution
- **DynamoDB Table** - Order state and transition receipts
- **CloudWatch Logs** - Full observability

## Architecture

```
Event Source → Durable Lambda (Workflow) → DynamoDB
```

## Order Workflow

```
PENDING → PROCESSING → SHIPPED
   │
   ├──▶ CANCELLED
   └──▶ FAILED
```

## Local Development

Start the local NestJS application on port 3000:

```bash
pnpm start
```

## Common Commands

```bash
# Development
pnpm build                # Type-check the example and bundle the Lambda handler
pnpm start                # Start the local NestJS application

# Deployment
pnpm deploy:dev           # Deploy to dev
pnpm deploy:prod          # Deploy to prod
pnpm diff                 # Preview changes
pnpm synth                # Synthesize CloudFormation

# Cleanup
pnpm destroy              # Remove the dev stack and its stored data
```

## Monitoring

### View Logs in Real-Time

```bash
aws logs tail /aws/lambda/order-state-machine-dev-order-workflow --follow
```

## Quick Tips

1. **Use CDK Outputs**: The alias ARN in the deployment output is what you use to invoke the function
2. **Check Logs**: Always check CloudWatch logs if something fails
3. **IAM Permissions**: Ensure your AWS user has proper permissions
4. **Cost**: Dev stage is mostly free tier eligible

## Troubleshooting

**Issue**: Deployment fails
**Fix**: Check AWS credentials with `aws sts get-caller-identity`

**Issue**: CDK bootstrap required
**Fix**: Follow the [CDK bootstrap step](#3-bootstrap-cdk) once per account and region.

**Issue**: Workflow not processing
**Fix**: Check Lambda logs with `aws logs tail`

**Issue**: Permission denied
**Fix**: Ensure IAM user has Lambda, DynamoDB, and CloudFormation permissions

## Next Steps

- Read [README.md](./README.md) for detailed documentation
- Explore source code in `src/` directory
- Customize workflow in `src/order/order.workflow.ts`

## Need Help?

- **Documentation**: [../../docs/](../../docs/)
- **GitHub Issues**: https://github.com/tung-dnt/nestflow-js/issues
- **AWS Docs**: https://aws.amazon.com/lambda/

See [durable claims and receipts](./README.md#durable-claims-and-receipts) before adding a handler that calls an external service.
