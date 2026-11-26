/**
 * Parameter decorator that injects the current workflow entity into a handler method.
 *
 * The entity is loaded when the entity service claims the transition.
 *
 * @example
 * ```typescript
 * @OnEvent('order.submit')
 * async onSubmit(@Entity() order: Order) { ... }
 * ```
 */
export function Entity(): ParameterDecorator {
  return (target: object, propertyKey?: string | symbol, parameterIndex?: number) => {
    if (!propertyKey || parameterIndex === undefined)
      throw new Error('Entity decorator can only be used on method parameters');
    const existing: Array<any> = Reflect.getOwnMetadata('workflow:params', target, propertyKey) || [];
    existing.push({ index: parameterIndex, type: 'entity' });
    Reflect.defineMetadata('workflow:params', existing, target, propertyKey);
  };
}

/**
 * Parameter decorator that injects the event payload into a handler method.
 *
 * The payload comes from the `payload` field of the incoming
 * {@link IWorkflowEvent}, or from the return value of the previous handler
 * when auto-transitioning (`continued` status).
 *
 * @param dto - Optional DTO class for validation (reserved for future use).
 *
 * @example
 * ```typescript
 * @OnEvent('order.submit')
 * async onSubmit(@Entity() order: Order, @Payload() data: SubmitDto) { ... }
 * ```
 */
export function Payload<P>(dto?: P): ParameterDecorator {
  return (target: object, propertyKey?: string | symbol, parameterIndex?: number) => {
    if (!propertyKey || parameterIndex === undefined)
      throw new Error('Payload decorator can only be used on method parameters');
    const existing: Array<any> = Reflect.getOwnMetadata('workflow:params', target, propertyKey) || [];
    existing.push({ index: parameterIndex, type: 'payload', dto });
    Reflect.defineMetadata('workflow:params', existing, target, propertyKey);
  };
}

/** Inject the stable delivery ID for downstream idempotency keys. */
export function EventId(): ParameterDecorator {
  return (target: object, propertyKey?: string | symbol, parameterIndex?: number) => {
    if (!propertyKey || parameterIndex === undefined)
      throw new Error('EventId decorator can only be used on method parameters');
    const existing: Array<{ index: number; type: string }> =
      Reflect.getOwnMetadata('workflow:params', target, propertyKey) || [];
    existing.push({ index: parameterIndex, type: 'eventId' });
    Reflect.defineMetadata('workflow:params', existing, target, propertyKey);
  };
}
