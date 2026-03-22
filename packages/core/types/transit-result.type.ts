import type { IWorkflowEvent } from './workflow-event.interface';

export type TransitResult =
  | { status: 'final'; state: string | number }
  | { status: 'idle'; state: string | number }
  | { status: 'continued'; nextEvent: IWorkflowEvent }
  | { status: 'no_transition'; state: string | number };
