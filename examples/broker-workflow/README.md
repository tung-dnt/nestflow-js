# One workflow, three message transports

The [deployment guide](../../docs/content/docs/deployment-architecture.mdx) compares this example with in-process execution and AWS Durable Lambda. The host files import the runtime adapters from `nestflow-js/adapter`. The example owns the order workflow, its PostgreSQL store, and the broker clients.

## Prepare the application

Run these commands from the repository root. Build the workspace library first so Vite Plus can type-check the example and write its entry points to `dist/`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter broker-workflow build
```

Set `DATABASE_URL` to an application database. Apply the schema once before starting any worker:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f examples/broker-workflow/schema.sql
```

Each host uses the same initial message. From `examples/broker-workflow`, create an order and print a message to publish. Save and reuse that **same** message if initial delivery fails.

```sh
node --input-type=module -e '
import { randomUUID } from "node:crypto";
import { createOrder, closeApp } from "./dist/app.js";
try {
  const urn = await createOrder();
  console.log(JSON.stringify({event: "order.submit", urn, eventId: randomUUID(), attempt: 0}));
} finally { await closeApp(); }'
```

The worker handles `order.submit`, publishes the committed `order.finish` continuation, and only then acknowledges the message. If the worker dies between commit and acknowledgement, the broker redelivers the message. The redelivery replays the stored receipt without running the handler again and republishes the continuation with the same event ID. There is no outbox or dispatcher to run.

## RabbitMQ in a container

To run without installing PostgreSQL or RabbitMQ locally, use Compose from the repository root:

```sh
docker compose -f examples/broker-workflow/compose.yaml up --build -d
docker compose -f examples/broker-workflow/compose.yaml run --rm worker node dist/container.js seed
```

Compose supplies `AMQP_URL` and `DATABASE_URL`. The worker consumes `RABBITMQ_QUEUE` (default `nestflow-workflow`) and publishes each continuation before it acknowledges the message. Use `docker compose -f examples/broker-workflow/compose.yaml down` to stop this stack.

## Azure Functions and Service Bus

Create a Service Bus queue. Set `SERVICE_BUS_QUEUE` to its name and `ServiceBusConnection` to a connection string scoped to send and listen on that queue. Set `DATABASE_URL`, `AzureWebJobsStorage`, and `FUNCTIONS_WORKER_RUNTIME=node` in the function app settings. Use the platform's secret store. Do not commit connection strings.

For local development, run `func start` from `examples/broker-workflow` after compiling. The v4 Node worker loads `dist/azure.js` through the package `main`. Send the initial event as a JSON message body. The Service Bus trigger handles the message and sends its continuation before the host completes it. Set a maximum delivery count and monitor the queue's dead-letter subqueue. For deployment, stage the compiled app, `host.json`, and production dependencies together rather than copying a workspace symlink.

## Cloud Run and Pub/Sub

Run the example image with `node dist/gcp.js` on a Cloud Run service that requires authentication. Configure `DATABASE_URL`, `PUBSUB_TOPIC`, and `PUBSUB_SUBSCRIPTION` (the full `projects/PROJECT/subscriptions/SUBSCRIPTION` name). Supply Google credentials through the service identity. Cloud Run supplies `PORT`.

- Configure a wrapped Pub/Sub push subscription to `POST /pubsub`. Set the OIDC audience to the service URL. Grant its push identity `roles/run.invoker` on the service.
- Grant the service identity permission to publish to the continuation topic. Attach a dead-letter policy to the subscription and grant the Pub/Sub service agent the [required permissions](https://cloud.google.com/pubsub/docs/dead-letter-topics).
- Publish the initial event's JSON as the message data. Pub/Sub supplies the base64 push envelope. Do not wrap or encode the event a second time.

The PostgreSQL example holds a row lock and a database connection while a handler runs. Use short handlers and bound worker concurrency to the connection budget across replicas.

## Verify recovery

Use a **test** PostgreSQL database. The verifier creates its own schema. It needs schema creation privileges but does not need a cloud account.

```sh
TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm --filter broker-workflow verify:recovery
```
