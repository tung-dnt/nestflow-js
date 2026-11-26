import {
  getRetryKey,
  WORKFLOW_DEFAULT_EVENT,
  WORKFLOW_DEFINITION_KEY,
  WORKFLOW_HANDLER_KEY,
  type IBackoffRetryConfig,
  type IWorkflowDefaultRoute,
  type IWorkflowDefinition,
  type IWorkflowEntity,
  type IWorkflowHandler,
  type TDefaultHandler,
  type TransitResult,
  type TransitionCompletion,
  type TransitionReceipt,
} from '@/core';
import { UnretriableException } from '@/exception/unretriable.exception';
import { BadRequestException, ConflictException, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { IWorkflowEvent } from '../types/workflow-event.interface';
import { StateRouterHelperFactory } from './router.factory';

function transitionFailure(message: string, cause: unknown, storageError: unknown): AggregateError {
  const diagnostic = cause instanceof Error ? `${message}: ${cause.message}` : message;
  return new AggregateError([cause, storageError], diagnostic, { cause });
}

/**
 * Central orchestration engine that discovers workflow definitions at startup
 * and routes incoming {@link IWorkflowEvent}s to the correct handler.
 *
 * Registered automatically by {@link WorkflowModule.register}. Adapters
 * (and application code) call {@link transit} to trigger state transitions
 * and receive a {@link TransitResult} describing the outcome.
 */
@Injectable()
export class OrchestratorService implements OnModuleInit {
  /** Event-name → route lookup table, built once during `onModuleInit`. */
  private routes = new Map<string, IWorkflowDefaultRoute>();
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly routerHelperFactory: StateRouterHelperFactory,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit() {
    const providers = this.discoveryService.getProviders();
    for (const provider of providers) {
      const { instance } = provider;
      if (!instance?.constructor) continue;

      const [workflowDefinition, handlerStore, defaultHandler] = [
        Reflect.getMetadata(WORKFLOW_DEFINITION_KEY, instance.constructor) as
          | IWorkflowDefinition<unknown, string, string | number>
          | undefined,
        Reflect.getMetadata(WORKFLOW_HANDLER_KEY, instance.constructor) as IWorkflowHandler[] | undefined,
        Reflect.getMetadata(WORKFLOW_DEFAULT_EVENT, instance.constructor) as TDefaultHandler<unknown> | undefined,
      ];

      if (!workflowDefinition) continue;

      const events = new Set(handlerStore?.map((handler) => handler.event));
      for (const transition of workflowDefinition.transitions) {
        const transitionEvents = Array.isArray(transition.event) ? transition.event : [transition.event];
        if (transitionEvents.length === 0) {
          throw new Error(`Empty transition event list in workflow: ${workflowDefinition.name}`);
        }
        for (const event of transitionEvents) {
          if (!events.has(event)) {
            throw new Error(`No handler registered for event: ${event} in workflow: ${workflowDefinition.name}`);
          }
        }
      }
      if (!handlerStore?.length) continue;

      const entityService = this.moduleRef.get<IWorkflowEntity>(workflowDefinition.entityService, { strict: true });
      if (typeof entityService.claimTransition !== 'function') {
        throw new Error(`Entity service for workflow ${workflowDefinition.name} must implement claimTransition`);
      }

      for (const handler of handlerStore) {
        if (this.routes.has(handler.event)) {
          throw new Error(
            `Duplicate workflow event handler detected for event: ${handler.event} in workflow: ${workflowDefinition.name}`,
          );
        }
        // Retrieve retry config from metadata on the handler function (not from DI container)
        const retryConfig = Reflect.getMetadata(getRetryKey(handler.name), handler.handler) as
          | IBackoffRetryConfig
          | undefined;
        if (retryConfig && (!Number.isSafeInteger(retryConfig.maxAttempts) || retryConfig.maxAttempts < 1)) {
          throw new Error(`Invalid maxAttempts for event: ${handler.event} in workflow: ${workflowDefinition.name}`);
        }

        this.routes.set(handler.event, {
          handler: handler.handler,
          definition: workflowDefinition,
          instance,
          handlerName: handler.name,
          retryConfig,
          defaultHandler,
          entityService,
        });
      }
    }
    this.logger.log(`StateRouter initialized with ${this.routes.size} routes: `, Array.from(this.routes.keys()));
  }

  /**
   * Returns the retry configuration attached to the handler for a given event,
   * or `undefined` if the handler has no `@WithRetry()` decorator.
   */
  getRetryConfig(event: string): IBackoffRetryConfig | undefined {
    return this.routes.get(event)?.retryConfig;
  }

  /** Execute one attempt. Direct callers do not schedule handler retries. */
  transit(params: IWorkflowEvent): Promise<TransitResult> {
    return this.transitAttempt(params, false);
  }

  /** Execute an attempt for an adapter. Only handler errors can request a retry. */
  transitAttempt(params: IWorkflowEvent, canRetry: false): Promise<TransitResult>;
  transitAttempt(params: IWorkflowEvent, canRetry: boolean): Promise<TransitResult | { status: 'retry' }>;
  async transitAttempt(params: IWorkflowEvent, canRetry: boolean): Promise<TransitResult | { status: 'retry' }> {
    const { urn, payload, event, eventId } = params;
    if (typeof eventId !== 'string' || !eventId.trim()) {
      throw new BadRequestException('A stable workflow eventId is required');
    }

    const route = this.routes.get(event);
    if (!route) throw new BadRequestException(`No workflow found for event: ${event}`);
    const { definition, instance, defaultHandler, entityService, handlerName, handler } = route;
    const logger = new Logger(`Router::${definition.name}`);
    const router = this.routerHelperFactory.create(event, entityService, definition);
    logger.log(`Handling workflow event ${event}`, { urn, eventId, handler: handlerName });

    const claim = await entityService.claimTransition(urn, eventId);
    if (claim.kind === 'missing') throw new BadRequestException('Entity not found', String(urn));
    if (claim.kind === 'busy') throw new ConflictException(`Entity ${urn} already has a transition in progress`);

    let receipt: TransitionReceipt<unknown>;
    if (claim.kind === 'completed') {
      receipt = claim.receipt;
    } else {
      const { entity } = claim;
      let committed = false;
      let failure: { cause: unknown } | undefined;
      try {
        const state = entityService.status(entity);
        const { transition, hasEventStateMatch } = router.findValidTransition(entity, payload);
        if (!transition) {
          if (hasEventStateMatch && router.isInIdleStatus(entity)) {
            return {
              status: 'idle',
              state,
              timeout: router.getIdleTimeout(state) ?? definition.defaultCallbackTimeout,
            };
          }
          await defaultHandler?.call(instance, entity, event, payload);
          throw new BadRequestException(`No matched transition for event: ${event}, status: ${state}`);
        }

        const args = router.buildParamDecorators(entity, payload, instance, handlerName, eventId);
        let completion: TransitionCompletion;
        let handlerFailure: { cause: unknown } | undefined;
        try {
          const output: unknown = await handler.apply(instance, args);
          completion = { kind: 'applied', output };
        } catch (cause) {
          if (cause instanceof UnretriableException) {
            completion = { kind: 'unretriable' };
          } else {
            if (canRetry) {
              failure = { cause };
              return { status: 'retry' };
            }
            completion = { kind: 'exhausted' };
          }
          handlerFailure = { cause };
        }

        try {
          receipt = await claim.commit(
            completion.kind === 'applied' ? transition.to : definition.states.failed,
            completion,
          );
          committed = true;
        } catch (error) {
          if (!handlerFailure) throw error;
          throw transitionFailure('Could not record workflow handler failure', handlerFailure.cause, error);
        }
        logger.log('Workflow transition committed', { urn, eventId, outcome: completion.kind });
        if (completion.kind === 'exhausted') throw handlerFailure?.cause;
      } catch (cause) {
        failure = { cause };
        throw cause;
      } finally {
        if (!committed) {
          try {
            await claim.release();
          } catch (error) {
            if (!failure) throw error;
            throw transitionFailure('Could not release workflow transition claim', failure.cause, error);
          }
        }
      }
    }

    const { entity, completion } = receipt;
    const state = entityService.status(entity);
    if (completion.kind === 'exhausted') throw new Error(`Workflow handler retry budget exhausted for event: ${event}`);
    if (completion.kind === 'unretriable' || definition.states.finals.includes(state)) {
      return { status: 'final', state };
    }
    if (router.isInIdleStatus(entity)) {
      return { status: 'idle', state, timeout: router.getIdleTimeout(state) ?? definition.defaultCallbackTimeout };
    }

    const { transition: nextTransition } = router.findValidTransition(entity, completion.output, {
      skipEventCheck: true,
    });
    if (!nextTransition) return { status: 'no_transition', state, timeout: definition.defaultCallbackTimeout };

    const nextEvent = Array.isArray(nextTransition.event) ? nextTransition.event[0] : nextTransition.event;
    return {
      status: 'continued',
      nextEvent: {
        event: nextEvent,
        urn,
        eventId: createHash('sha256')
          .update(JSON.stringify(['nestflow:continue', eventId, nextEvent]))
          .digest('hex'),
        payload: completion.output,
        attempt: 0,
      },
    };
  }
}
