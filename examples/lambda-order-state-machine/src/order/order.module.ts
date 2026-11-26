import { Module } from '@nestjs/common';
import { WorkflowModule } from 'nestflow-js/core';

import { OrderEntityService } from './order-entity.service.js';
import { ORDER_WORKFLOW_ENTITY } from './order.constant.js';
import { OrderWorkflow } from './order.workflow.js';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: ORDER_WORKFLOW_ENTITY, useClass: OrderEntityService }],
      workflows: [OrderWorkflow],
    }),
  ],
})
export class OrderModule {}
