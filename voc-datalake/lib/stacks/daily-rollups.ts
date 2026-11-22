/**
 * VocProcessingStack's daily rollups, added together so the stack's constructor holds one call for both (it is at the
 * 400-line limit): cost per workspace (`voc-cost-rollup`, cost-rollup-worker.ts; docs/multi-workspace.md "Cost per
 * workspace") and the leadership view (`voc-adoption-rollup`, adoption-rollup-worker.ts, 7.70.00;
 * docs/leadership-view.md). Each keeps its construct id directly under the stack, so its logical ids are its own.
 */
import type { Construct } from 'constructs';

import { createAdoptionRollupWorker } from './adoption-rollup-worker';
import type { AdoptionRollupWorkerProps } from './adoption-rollup-worker';
import { createCostRollupWorker } from './cost-rollup-worker';

/** Both rollups' props: the leadership view's (it reads the most tables) and the cost rollup's log groups. */
export interface DailyRollupsProps extends AdoptionRollupWorkerProps {
  /** The deployment's Lambda log groups, `/aws/lambda/[<prefix>-]voc-*-<account>-<region>` (the cost rollup's). */
  lambdaLogGroupPattern: string;
}

export function addDailyRollups(stack: Construct, props: DailyRollupsProps): void {
  const { uniqueName, layer, kmsKey, aggregatesTable, workspacesTable } = props;
  createCostRollupWorker(stack, 'CostRollupWorker', {
    uniqueName, layer, kmsKey, aggregatesTable, workspacesTable, lambdaLogGroupPattern: props.lambdaLogGroupPattern,
  });
  createAdoptionRollupWorker(stack, 'AdoptionRollupWorker', {
    uniqueName, layer, kmsKey, aggregatesTable, workspacesTable, projectsTable: props.projectsTable,
    conversationsTable: props.conversationsTable, agentsTable: props.agentsTable,
  });
}
