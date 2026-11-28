import Joi from 'joi';

/** Validates a workflow payload with Joi, including coercion and external rules. */
export function joiPayloadValidator(schema: unknown, payload: unknown): Promise<unknown> {
  if (!Joi.isSchema(schema)) throw new TypeError('Expected a Joi schema in @Payload()');
  return schema.validateAsync(payload);
}
