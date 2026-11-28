/** Parses a workflow payload with a Zod schema, including asynchronous refinements. */
export function zodPayloadValidator(schema: unknown, payload: unknown): unknown {
  if (!schema || typeof schema !== 'object' || !('parseAsync' in schema) || typeof schema.parseAsync !== 'function') {
    throw new TypeError('Expected a Zod schema in @Payload()');
  }
  return schema.parseAsync(payload);
}
