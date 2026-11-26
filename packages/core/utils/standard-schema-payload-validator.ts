import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Validates workflow payloads with a Standard Schema v1 schema and returns its parsed output. */
export async function standardSchemaPayloadValidator(schema: unknown, payload: unknown): Promise<unknown> {
  const standard =
    schema !== null && (typeof schema === 'object' || typeof schema === 'function') && '~standard' in schema
      ? schema['~standard']
      : undefined;
  if (
    !standard ||
    typeof standard !== 'object' ||
    !('version' in standard) ||
    standard.version !== 1 ||
    !('validate' in standard) ||
    typeof standard.validate !== 'function'
  ) {
    throw new TypeError('Expected a Standard Schema v1 schema in @Payload()');
  }

  const result = await (standard as Pick<StandardSchemaV1['~standard'], 'validate'>).validate(payload);
  if (result.issues) throw new Error(result.issues.map((issue) => issue.message).join('; '));
  return result.value;
}
