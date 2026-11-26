/** Asserts a workflow payload against an ArkType schema and returns its output. */
export function arkTypePayloadValidator(schema: unknown, payload: unknown): unknown {
  if (typeof schema !== 'function' || !('assert' in schema) || typeof schema.assert !== 'function') {
    throw new TypeError('Expected an ArkType schema in @Payload()');
  }
  return schema.assert(payload);
}
