import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { processWorkflowMessage, recoverNextTransition } from 'nestflow-js/adapter';
import { OrchestratorService, WorkflowModule, type IWorkflowEvent } from 'nestflow-js/core';

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

export async function consume(raw: unknown): Promise<void> {
  const { orchestrator } = await getApp();
  await processWorkflowMessage(orchestrator, raw);
}

export async function dispatchOne(publish: (event: IWorkflowEvent) => Promise<void>): Promise<boolean> {
  const { orchestrator, store } = await getApp();
  return recoverNextTransition(orchestrator, store, async (result) => {
    if (result.status === 'continued') await publish(result.nextEvent);
  });
}

export async function createOrder(): Promise<string> {
  const { store } = await getApp();
  return (await store.create()).id;
}

export async function closeApp(): Promise<void> {
  if (app) await (closing ??= app.then(({ context }) => context.close()));
}
