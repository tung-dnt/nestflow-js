import { Module } from '@nestjs/common';
import { WORKFLOW_HISTORY, WorkflowModule } from 'nestflow-js/core';

import { OrderEntityService } from './order-entity.service.js';
import { ORDER_WORKFLOW_ENTITY } from './order.constant.js';
import { OrderWorkflow } from './order.workflow.js';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: ORDER_WORKFLOW_ENTITY, useClass: OrderEntityService }],
      workflows: [OrderWorkflow],
      providers:
        process.env.WORKFLOW_HISTORY === 'true' ? [{ provide: WORKFLOW_HISTORY, useExisting: ORDER_WORKFLOW_ENTITY }] : [],
    }),
  ],
})
export class OrderModule {}
