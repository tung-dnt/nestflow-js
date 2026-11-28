import { ConflictException } from '@nestjs/common';

/** A durable cancellation request prevents this entity from starting another transition. */
export class WorkflowCancelledException extends ConflictException {
  constructor() {
    super('Workflow cancellation requested');
  }
}
