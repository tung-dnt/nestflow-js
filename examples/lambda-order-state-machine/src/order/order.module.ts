import { Module } from '@nestjs/common';
import { WorkflowModule } from 'nestjs-serverless-workflow/core';

import { OrderEntityService } from './order-entity.service';
import { ORDER_WORKFLOW_ENTITY } from './order.constant';
import { OrderWorkflow } from './order.workflow';

@Module({
  imports: [
    WorkflowModule.register({
      entities: [{ provide: ORDER_WORKFLOW_ENTITY, useClass: OrderEntityService }],
      workflows: [OrderWorkflow],
    }),
  ],
})
export class OrderModule {}
