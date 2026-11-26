import { BadRequestException } from '@nestjs/common';
import { RouterService } from '@/core/providers/router.service';
import type { IWorkflowDefinition, PayloadValidator } from '@/core/types';
import { describe, expect, test } from 'bun:test';

const mockEntityService = { status: (entity: { status: string }) => entity.status };

const mockDefinition: IWorkflowDefinition<any, string, string> = {
  name: 'TestWorkflow',
  states: { finals: ['DONE'], idles: ['PENDING'], failed: 'FAILED' },
  transitions: [{ event: 'start', from: ['PENDING'], to: 'ACTIVE' }],
  entityService: 'entity.test',
};

// Helper: create a class with @Entity() + @Payload(dto?) metadata on a method
function createHandlerTarget(dto?: unknown) {
  class TestHandler {
    async handle(_entity: any, _payload: any) {
      return 'ok';
    }
  }
  // Simulate decorator metadata: @Entity() at index 0, @Payload(dto) at index 1
  Reflect.defineMetadata(
    'workflow:params',
    [
      { index: 0, type: 'entity' },
      { index: 1, type: 'payload', dto },
    ],
    TestHandler.prototype,
    'handle',
  );
  return new TestHandler();
}

describe('RouterService – payload validation', () => {
  const entity = { id: '1', status: 'PENDING' };
  const rawPayload = { amount: '42', name: 'test' };

  test('passes raw payload through when no dto is set', () => {
    const router = new RouterService('start', mockEntityService, mockDefinition, null);
    const target = createHandlerTarget(/* no dto */);
    const args = router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toBe(rawPayload);
  });

  test('passes raw payload through when dto is set but no validator provided', () => {
    const fakeSchema = { type: 'object' };
    const router = new RouterService('start', mockEntityService, mockDefinition, null);
    const target = createHandlerTarget(fakeSchema);
    const args = router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toBe(rawPayload);
  });

  test('calls validator and returns transformed payload when dto and validator are present', () => {
    const fakeSchema = { coerce: true };
    const validator: PayloadValidator = (schema, payload) => {
      // Simulate a transform: coerce amount to number
      const p = payload as Record<string, unknown>;
      return { ...p, amount: Number(p.amount) };
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);
    const args = router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toEqual({ amount: 42, name: 'test' });
  });

  test('throws BadRequestException when validator throws', () => {
    const fakeSchema = { strict: true };
    const validator: PayloadValidator = () => {
      throw new Error('Invalid field "foo"');
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);

    expect(() => router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1')).toThrow(
      BadRequestException,
    );
  });

  test('includes original error message in BadRequestException', () => {
    const fakeSchema = {};
    const validator: PayloadValidator = () => {
      throw new Error('field "email" is required');
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);

    try {
      router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).message).toContain('field "email" is required');
    }
  });

  test('legacy fallback (no decorator metadata) is unaffected by validator', () => {
    const validator: PayloadValidator = () => {
      throw new Error('should not be called');
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);

    // Target with NO metadata — triggers legacy { entity, payload } shape
    class LegacyHandler {
      async handle(_data: any) {
        return 'ok';
      }
    }
    const target = new LegacyHandler();
    const args = router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args).toEqual([{ entity, payload: rawPayload }]);
  });
});
