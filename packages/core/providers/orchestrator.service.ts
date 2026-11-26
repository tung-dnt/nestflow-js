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
import { WorkflowCancelledException } from '@/exception/workflow-cancelled.exception';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { IWorkflowEvent } from '../types/workflow-event.interface';
import {
  WORKFLOW_TELEMETRY,
  type TransitionTelemetryContext,
  type TransitionTrace,
  type WorkflowTelemetry,
} from '../types/workflow-telemetry.interface';
import {
  WORKFLOW_HISTORY,
  type TransitionCommitMetadata,
  type WorkflowHistoryReader,
} from '../types/workflow-recovery.interface';
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
    @Optional() @Inject(WORKFLOW_TELEMETRY) private readonly telemetry?: WorkflowTelemetry,
    @Optional() @Inject(WORKFLOW_HISTORY) private readonly history?: WorkflowHistoryReader,
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

  /** Request cancellation of the entity handled by the specified workflow event route. */
  requestCancellation(event: string, urn: string | number): Promise<boolean> {
    const route = this.routes.get(event);
    if (!route) throw new BadRequestException(`No workflow found for event: ${event}`);
    const cancellation = route.entityService.cancellation;
    if (!cancellation) throw new BadRequestException('Workflow cancellation is not configured');
    return cancellation.request(urn);
  }

  /** Execute one attempt. Direct callers do not schedule handler retries. */
  transit(params: IWorkflowEvent): Promise<TransitResult> {
    return this.transitAttempt(params, false);
  }

  /** Execute an attempt for an adapter. Only handler errors can request a retry. */
  transitAttempt(params: IWorkflowEvent, canRetry: false): Promise<TransitResult>;
  transitAttempt(params: IWorkflowEvent, canRetry: boolean): Promise<TransitResult | { status: 'retry' }>;
  async transitAttempt(params: IWorkflowEvent, canRetry: boolean): Promise<TransitResult | { status: 'retry' }> {
    const route = this.routes.get(params.event);
    const telemetry = this.telemetry;
    if (!telemetry) return this.executeAttempt(params, canRetry, route);

    const context = route && { workflow: route.definition.name, event: params.event, attempt: params.attempt };
    const startedAtMs = Date.now();
    const start = performance.now();
    let outcome: TransitionTrace['outcome'] = 'error';
    try {
      const result = await this.executeAttempt(params, canRetry, route, context);
      outcome = result.status;
      if (context && outcome === 'retry') {
        this.sendTelemetry(() => telemetry.log({ ...context, kind: 'retry_requested' }));
      }
      return result;
    } finally {
      const durationMs = performance.now() - start;
      this.sendTelemetry(() => telemetry.trace({ ...context, startedAtMs, durationMs, outcome }));
    }
  }

  private sendTelemetry(send: () => void | Promise<void>): void {
    try {
      const pending = send();
      if (pending) void pending.catch(() => {});
    } catch {
      // Telemetry cannot change a workflow outcome.
    }
  }

  private async executeAttempt(
    params: IWorkflowEvent,
    canRetry: boolean,
    route: IWorkflowDefaultRoute | undefined,
    context?: TransitionTelemetryContext,
  ): Promise<TransitResult | { status: 'retry' }> {
    const { urn, payload, event, eventId } = params;
    if (typeof eventId !== 'string' || !eventId.trim()) {
      throw new BadRequestException('A stable workflow eventId is required');
    }

    if (!route) throw new BadRequestException(`No workflow found for event: ${event}`);
    const { definition, instance, defaultHandler, entityService, handlerName, handler } = route;
    const logger = new Logger(`Router::${definition.name}`);
    const router = this.routerHelperFactory.create(event, entityService, definition);
    logger.log(`Handling workflow event ${event}`, { urn, eventId, handler: handlerName });

    const claim = await entityService.claimTransition(urn, eventId);
    if (claim.kind === 'missing') throw new BadRequestException('Entity not found', String(urn));
    if (claim.kind === 'cancelled') throw new WorkflowCancelledException();
    if (claim.kind === 'busy') {
      if (context) this.sendTelemetry(() => this.telemetry?.log({ ...context, kind: 'claim_busy' }));
      throw new ConflictException(`Entity ${urn} already has a transition in progress`);
    }

    let receipt: TransitionReceipt<unknown>;
    if (claim.kind === 'completed') {
      receipt = claim.receipt;
      if (context) {
        const outcome = receipt.completion.kind;
        this.sendTelemetry(() => this.telemetry?.log({ ...context, kind: 'receipt_replayed', outcome }));
      }
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

        const targetState = completion.kind === 'applied' ? transition.to : definition.states.failed;
        try {
          receipt = await claim.commit(
            targetState,
            completion,
            { workflow: definition.name, event, eventId, urn, from: state },
            this.history && true,
          );
          committed = true;
        } catch (error) {
          if (context) this.sendTelemetry(() => this.telemetry?.log({ ...context, kind: 'commit_unconfirmed' }));
          if (!handlerFailure) throw error;
          throw transitionFailure('Could not record workflow handler failure', handlerFailure.cause, error);
        }
        if (context) {
          this.sendTelemetry(() =>
            this.telemetry?.log({
              ...context,
              kind: 'transition_committed',
              from: state,
              to: targetState,
              outcome: completion.kind,
            }),
          );
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

    return this.resolveReceipt({ event, eventId, urn }, route, receipt);
  }

  /** Resolve committed work from a trusted storage provider without running the original handler. */
  async resumeCommitted(
    transition: TransitionCommitMetadata,
    receipt: TransitionReceipt<unknown>,
  ): Promise<TransitResult> {
    const route = this.routes.get(transition.event);
    if (!route || route.definition.name !== transition.workflow) {
      throw new Error(`Cannot resume committed event ${transition.event} in workflow ${transition.workflow}`);
    }
    return this.resolveReceipt(transition, route, receipt);
  }

  private async resolveReceipt(
    { event, eventId, urn }: Pick<IWorkflowEvent, 'event' | 'eventId' | 'urn'>,
    { definition, entityService }: IWorkflowDefaultRoute,
    receipt: TransitionReceipt<unknown>,
  ): Promise<TransitResult> {
    if (entityService.cancellation && (await entityService.cancellation.isRequested(urn))) {
      throw new WorkflowCancelledException();
    }
    const router = this.routerHelperFactory.create(event, entityService, definition);
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
