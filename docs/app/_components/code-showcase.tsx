'use client';

import { useState } from 'react';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';

const definitionTabs = [
  {
    label: 'Workflow',
    lang: 'ts',
    code: `import { Workflow, OnEvent, Entity, Payload } from 'nestflow-js/core';

@Workflow({
  name: 'OrderWorkflow',
  states: {
    finals: ['paid', 'cancelled'],
    idles: ['pending_payment'],
    failed: 'cancelled',
  },
  transitions: [
    { event: 'PAYMENT_RECEIVED', from: ['pending_payment'], to: 'paid' },
  ],
  entityService: 'entity.order',
})
export class OrderWorkflow {
  @OnEvent('PAYMENT_RECEIVED')
  async onPayment(@Entity() order, @Payload() payload) {
    order.paidAt = new Date();
    return order;
  }
}`,
  },
  {
    label: 'Entity Service',
    lang: 'ts',
    code: `import type { IWorkflowEntity, TransitionClaim } from 'nestflow-js/core';
import type { Observable } from 'rxjs';

// The storage adapter claims the order before the handler runs.
interface OrderEntityService extends IWorkflowEntity<Order, OrderState> {
  claimTransition(
    urn: string | number,
    eventId: string,
  ): Observable<TransitionClaim<Order, OrderState>>;

  // The claim's commit persists the state and event receipt atomically.
}`,
  },
];

const usageTabs = [
  {
    label: 'Service',
    lang: 'ts',
    code: `import { OrchestratorService } from 'nestflow-js/core';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class OrderService {
  constructor(private orchestrator: OrchestratorService) {}

  async processPayment(orderId: string, eventId: string, payload: PaymentDto) {
    const result = await firstValueFrom(this.orchestrator.transit({
      event: 'PAYMENT_RECEIVED',
      urn: orderId,
      eventId,
      payload,
      attempt: 0,
    }));

    // result.status: 'final' | 'idle' | 'continued' | 'no_transition'
    return result;
  }
}`,
  },
  {
    label: 'Lambda',
    lang: 'ts',
    code: `import { NestFactory } from '@nestjs/core';
import { DurableLambdaEventHandler } from 'nestflow-js/adapter';
import { withDurableExecution } from '@aws/durable-execution-sdk-js';
import { AppModule } from './app.module';

const app = await NestFactory.createApplicationContext(AppModule);

export const handler = DurableLambdaEventHandler(app, withDurableExecution);
// Automatic checkpoint & replay across Lambda invocations
// Idle states pause via waitForCallback()
// Final states end the durable execution`,
  },
];

function TabbedCode({ tabs }: { tabs: { label: string; lang: string; code: string }[] }) {
  const [active, setActive] = useState(0);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-fd-border">
      <div className="flex border-b border-fd-border bg-fd-card">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            className={`cursor-pointer border-b-2 px-5 py-2.5 text-sm font-semibold transition-colors ${
              i === active
                ? 'border-[#e0234e] text-[#e0234e]'
                : 'border-transparent text-fd-muted-foreground hover:text-[#e0234e]'
            } -mb-px bg-transparent`}
            onClick={() => setActive(i)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <DynamicCodeBlock lang={tabs[active].lang} code={tabs[active].code} />
    </div>
  );
}

export function CodeShowcase() {
  return (
    <section className="bg-fd-secondary/50 px-6 py-16 md:py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="mb-2 text-center text-3xl font-bold text-fd-foreground">Define, Transit, Done</h2>
        <p className="mb-10 text-center text-lg text-fd-muted-foreground">
          Define workflows with decorators, transit states with a clean type-safe API
        </p>
        <div className="grid gap-8 md:grid-cols-2">
          <TabbedCode tabs={definitionTabs} />
          <TabbedCode tabs={usageTabs} />
        </div>
      </div>
    </section>
  );
}
