import { BadRequestException } from '@nestjs/common';
import { type } from 'arktype';
import Joi from 'joi';
import * as v from 'valibot';
import { z } from 'zod';
import { standardSchemaPayloadValidator } from '@/core';
import { RouterService } from '@/core/providers/router.service';
import type { IWorkflowDefinition, PayloadValidator } from '@/core/types';
import { arkTypePayloadValidator } from '@/validator/arktype/index';
import { joiPayloadValidator } from '@/validator/joi/index';
import { valibotPayloadValidator } from '@/validator/valibot/index';
import { zodPayloadValidator } from '@/validator/zod/index';
import { describe, expect, test } from 'vite-plus/test';

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

  test('passes raw payload through when no dto is set', async () => {
    const router = new RouterService('start', mockEntityService, mockDefinition, null);
    const target = createHandlerTarget(/* no dto */);
    const args = await router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toBe(rawPayload);
  });

  test('passes raw payload through when dto is set but no validator provided', async () => {
    const fakeSchema = { type: 'object' };
    const router = new RouterService('start', mockEntityService, mockDefinition, null);
    const target = createHandlerTarget(fakeSchema);
    const args = await router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toBe(rawPayload);
  });

  test('calls validator and returns transformed payload when dto and validator are present', async () => {
    const fakeSchema = { coerce: true };
    const validator: PayloadValidator = (schema, payload) => {
      // Simulate a transform: coerce amount to number
      const p = payload as Record<string, unknown>;
      return { ...p, amount: Number(p.amount) };
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);
    const args = await router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args[0]).toBe(entity);
    expect(args[1]).toEqual({ amount: 42, name: 'test' });
  });

  test.each([
    {
      validator: zodPayloadValidator,
      schema: z
        .string()
        .min(1)
        .transform(async (value) => value.length),
    },
    {
      validator: valibotPayloadValidator,
      schema: v.pipe(
        v.string(),
        v.minLength(1),
        v.transform((s) => s.length),
      ),
    },
    { validator: arkTypePayloadValidator, schema: type('string > 0').pipe((value) => value.length) },
    { validator: joiPayloadValidator, schema: Joi.string().external((value: string) => value.length) },
  ])('$validator passes parsed output to the handler and rejects invalid payloads', async ({ validator, schema }) => {
    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(schema);
    await expect(router.buildParamDecorators(entity, 'abc', target, 'handle', 'event-1')).resolves.toEqual([entity, 3]);
    await expect(router.buildParamDecorators(entity, '', target, 'handle', 'event-1')).rejects.toThrow(
      BadRequestException,
    );
    const wrongSchema = validator === joiPayloadValidator ? z.string() : Joi.string();
    const wrongTarget = createHandlerTarget(wrongSchema);
    await expect(router.buildParamDecorators(entity, 'abc', wrongTarget, 'handle', 'event-1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(standardSchemaPayloadValidator(schema, 'abc')).resolves.toBe(3);
  });

  test('rejects unsupported schemas rather than passing the raw payload', async () => {
    const router = new RouterService('start', mockEntityService, mockDefinition, standardSchemaPayloadValidator);
    const target = createHandlerTarget({});
    await expect(router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  test('throws BadRequestException when validator throws', async () => {
    const fakeSchema = { strict: true };
    const validator: PayloadValidator = () => {
      throw new Error('Invalid field "foo"');
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);

    await expect(router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  test('includes original error message in BadRequestException', async () => {
    const fakeSchema = {};
    const validator: PayloadValidator = () => {
      throw new Error('field "email" is required');
    };

    const router = new RouterService('start', mockEntityService, mockDefinition, validator);
    const target = createHandlerTarget(fakeSchema);
    await expect(router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1')).rejects.toThrow(
      'field "email" is required',
    );
  });

  test('legacy fallback (no decorator metadata) is unaffected by validator', async () => {
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
    const args = await router.buildParamDecorators(entity, rawPayload, target, 'handle', 'event-1');

    expect(args).toEqual([{ entity, payload: rawPayload }]);
  });
});
