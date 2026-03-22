import type { IDurableContext, WithDurableExecution } from '@/adapter';

/**
 * Mock DurableContext for testing.
 * Simulates checkpoint/replay by recording step results.
 */
export class MockDurableContext implements IDurableContext {
  private steps = new Map<string, any>();
  private callbacks = new Map<string, { resolve: (value: any) => void; promise: Promise<any> }>();
  private callbackWaiters = new Map<string, () => void>();
  readonly logger = {
    info: (_msg: string, _data?: any) => {},
  };

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (this.steps.has(name)) {
      return this.steps.get(name);
    }
    const result = await fn();
    this.steps.set(name, result);
    return result;
  }

  async waitForCallback<T>(
    name: string,
    onRegister: (callbackId: string) => Promise<void>,
    _options?: { timeout?: { hours?: number; minutes?: number; seconds?: number } },
  ): Promise<T> {
    const callbackId = `callback:${name}`;
    let resolve: (value: any) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    this.callbacks.set(callbackId, { resolve: resolve!, promise });

    // Notify anyone waiting for this callback to be registered
    const waiter = this.callbackWaiters.get(name);
    if (waiter) waiter();

    await onRegister(callbackId);
    return promise;
  }

  async wait(_duration: { seconds?: number; minutes?: number; hours?: number }): Promise<void> {}

  /**
   * Wait until a specific callback is registered by the adapter.
   * Use this in tests instead of setTimeout for reliable coordination.
   */
  waitUntilCallbackRegistered(name: string): Promise<void> {
    const callbackId = `callback:${name}`;
    if (this.callbacks.has(callbackId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.callbackWaiters.set(name, resolve);
    });
  }

  /**
   * Submit a callback result — simulates external system calling
   * SendDurableExecutionCallbackSuccess
   */
  submitCallback(name: string, payload: any): void {
    const callbackId = `callback:${name}`;
    const entry = this.callbacks.get(callbackId);
    if (!entry) throw new Error(`No callback registered for: ${callbackId}`);
    entry.resolve(payload);
  }

  getCompletedSteps(): string[] {
    return Array.from(this.steps.keys());
  }

  getStepResult(name: string): any {
    return this.steps.get(name);
  }
}

/**
 * Mock withDurableExecution — returns the raw handler so tests can call it with a mock context.
 */
export const mockWithDurableExecution: WithDurableExecution = (handler) => {
  return handler as any;
};
