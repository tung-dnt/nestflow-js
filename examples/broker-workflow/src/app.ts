import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { processWorkflowMessage } from 'nestflow-js/adapter';
import { OrchestratorService, WorkflowModule, type TransitResult } from 'nestflow-js/core';
import { firstValueFrom } from 'rxjs';

import { ORDER_ENTITY, OrderWorkflow } from './order.workflow.js';
import { PostgresOrderStore } from './store.js';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: ORDER_ENTITY, useClass: PostgresOrderStore }],
      workflows: [OrderWorkflow],
    }),
  ],
})
class OrderModule {}

type OrderApp = {
  context: INestApplicationContext;
  orchestrator: OrchestratorService;
  store: PostgresOrderStore;
};

async function startApp(): Promise<OrderApp> {
  const context = await NestFactory.createApplicationContext(OrderModule, { abortOnError: false });
  return {
    context,
    orchestrator: context.get(OrchestratorService),
    store: context.get<PostgresOrderStore>(ORDER_ENTITY),
  };
}

let app: Promise<OrderApp> | undefined;
let closing: Promise<void> | undefined;

function getApp() {
  if (closing) throw new Error('The broker workflow application is closed');
  return (app ??= startApp());
}

/** Run one transition. The transport adapter publishes a continuation before it acknowledges the message. */
export async function consume(raw: unknown): Promise<TransitResult> {
  const { orchestrator } = await getApp();
  return firstValueFrom(processWorkflowMessage(orchestrator, raw));
}

export async function createOrder(): Promise<string> {
  const { store } = await getApp();
  return (await firstValueFrom(store.create())).id;
}

export async function closeApp(): Promise<void> {
  if (app) await (closing ??= app.then(({ context }) => context.close()));
}
