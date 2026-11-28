import {
  GetDurableExecutionHistoryCommand,
  LambdaClient,
  ListDurableExecutionsByFunctionCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { Injectable } from '@nestjs/common';
import type { TransitResult, WorkflowHistory, WorkflowHistoryEntry, WorkflowHistoryPage } from 'nestflow-js/core';

const lambda = new LambdaClient({});

/**
 * Reads history from and cancels the order's durable execution. The execution must be
 * started with the order ID as its durable execution name. Checkpoints already hold each
 * entry, so there is no `record()` and no extra storage.
 */
@Injectable()
export class OrderExecutionService implements WorkflowHistory {
  async list(urn: string | number, limit: number, cursor?: string): Promise<WorkflowHistoryPage> {
    const executionArn = await this.findExecution(urn);
    if (!executionArn) return { entries: [] };
    const page = await lambda.send(
      new GetDurableExecutionHistoryCommand({
        DurableExecutionArn: executionArn,
        IncludeExecutionData: true,
        MaxItems: limit,
        Marker: cursor,
      }),
    );
    const entries: WorkflowHistoryEntry[] = [];
    for (const event of page.Events ?? []) {
      const result = event.StepSucceededDetails?.Result;
      if (!result || !event.Name?.startsWith('transit:')) continue;
      if (result.Truncated) throw new Error(`Durable checkpoint ${event.Name} is truncated`);
      const history = (JSON.parse(result.Payload ?? 'null') as TransitResult | null)?.history;
      if (history) entries.push(history);
    }
    return { entries, cursor: page.NextMarker };
  }

  /** Stop the order's running or paused execution. Returns false if there is none. */
  async cancel(urn: string | number): Promise<boolean> {
    const executionArn = await this.findExecution(urn, true);
    if (!executionArn) return false;
    await lambda.send(new StopDurableExecutionCommand({ DurableExecutionArn: executionArn }));
    return true;
  }

  private async findExecution(urn: string | number, active = false): Promise<string | undefined> {
    const functionName = process.env.ORDER_WORKFLOW_FUNCTION;
    if (!functionName) throw new Error('ORDER_WORKFLOW_FUNCTION is required');
    const { DurableExecutions } = await lambda.send(
      new ListDurableExecutionsByFunctionCommand({
        FunctionName: functionName,
        DurableExecutionName: String(urn),
        ...(active && { Statuses: ['RUNNING', 'PAUSED'] }),
      }),
    );
    return DurableExecutions?.[0]?.DurableExecutionArn;
  }
}
