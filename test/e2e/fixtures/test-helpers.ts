import type { IWorkflowEntity } from '@/core';

/**
 * Create a workflow event for testing
 */
export function createWorkflowEvent(event: string, urn: string | number, payload?: any, attempt = 0) {
  return {
    event,
    urn,
    payload,
    attempt,
  };
}

/**
 * Assert entity is in expected state
 */
export function assertEntityState<T>(entity: T, entityService: IWorkflowEntity<T>, expectedState: any): void {
  const actualState = entityService.status(entity);
  if (actualState !== expectedState) {
    throw new Error(`Expected entity to be in state "${expectedState}" but was in state "${actualState}"`);
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(condition: () => boolean, timeout = 5000, interval = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Create a delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
