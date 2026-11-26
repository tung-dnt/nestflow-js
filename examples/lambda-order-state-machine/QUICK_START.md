# Quick Start Guide

Deploy the order workflow and process a pending order with Durable Lambda.

## Fast Setup

### 1. Build the library and install example dependencies

Run these commands from the repository root. The example uses the library built from this checkout.

```bash
bun install
bun run build
cd examples/lambda-order-state-machine
bun install
```

### 2. Configure AWS (if not already done)

```bash
aws configure
# Enter your AWS credentials
```

### 3. Bootstrap CDK (first time only)

```bash
bunx cdk bootstrap
```

### 4. Deploy to AWS (2-3 minutes)

```bash
bun run deploy:dev
```

### 5. Seed and process an order

Use the table name and function alias ARN from the deployment output. Seed a pending order without overwriting an existing row:

```bash
aws dynamodb put-item \
  --table-name order-state-machine-orders-dev \
  --condition-expression 'attribute_not_exists(id)' \
  --item '{"id":{"S":"0195146b-1ab7-7dcd-9d26-60eb422f767d"},"item":{"S":"laptop"},"quantity":{"N":"1"},"price":{"N":"999"},"status":{"S":"pending"}}'
```

Invoke the Lambda with the order ID and a stable `eventId`. Reuse that event ID when you retry the same request.

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

Run locally without deploying:

```bash
bun run start:dev
```

## Common Commands

```bash
# Development
bun install               # Install dependencies
bun run build             # Compile TypeScript
bun run start             # Run locally
bun run start:dev         # Run with hot reload

# Deployment
bun run deploy:dev        # Deploy to dev
bun run deploy:prod       # Deploy to prod
bun run diff              # Preview changes
bun run synth             # Synthesize CloudFormation

# Cleanup
bun run destroy           # Remove deployment
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
**Fix**: Run `bunx cdk bootstrap` once per account/region

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
