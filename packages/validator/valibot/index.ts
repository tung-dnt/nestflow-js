import { type GenericSchema, type GenericSchemaAsync, parseAsync } from 'valibot';

/** Parses a workflow payload with a synchronous or asynchronous Valibot schema. */
export function valibotPayloadValidator(schema: unknown, payload: unknown): Promise<unknown> {
  if (!schema || typeof schema !== 'object' || !('~run' in schema) || typeof schema['~run'] !== 'function') {
    throw new TypeError('Expected a Valibot schema in @Payload()');
  }
  return parseAsync(schema as GenericSchema | GenericSchemaAsync, payload);
}
