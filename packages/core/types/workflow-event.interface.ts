export interface IWorkflowEvent<T = any> {
  event: string;
  urn: string | number;
  payload?: T | object | string;
  attempt: number;
}
