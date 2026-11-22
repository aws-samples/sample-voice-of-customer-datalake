/**
 * Cost per workspace's daily rollup, `voc-cost-rollup` (VocProcessingStack, docs/multi-workspace.md "Cost per
 * workspace"; handler lambda/jobs/cost_rollup/handler.py). Built like voc-radar-scan (radar-scan-worker.ts).
 *
 * At 02:15 UTC it rolls up yesterday and the day before from the `bedrock_usage` log lines (one Logs Insights query
 * per 50 of the deployment's `voc-*` Lambda log groups), and writes one whole row per workspace-day; an operator's
 * async invoke with `{"days": [...]}` backfills up to 29 days back (the groups keep 30).
 *
 * Least privilege (lib/stacks/cost-rollup-worker.test.ts pins every statement):
 *   - logs:DescribeLogGroups (a list call, authorized against `log-group:*`); logs:StartQuery on the deployment's
 *     `/aws/lambda/[<prefix>-]voc-*-<account>-<region>` groups only; logs:GetQueryResults and logs:StopQuery on `*`
 *     (they take no resource type: lib/utils/resource-star-actions.ts);
 *   - voc-aggregates: PutItem only, held by `dynamodb:LeadingKeys` to `WS#<one id>#COST`, `DEPLOYMENT#COST` and
 *     `UNATTRIBUTED#COST` (no read, no update, no delete: a rerun overwrites the whole item);
 *   - voc-workspaces: a `META`'s status only (`grantWorkspaceStatusRead`: no row is written for a workspace that is
 *     not active);
 *   - the Core key for both tables. No Bedrock: the job calls no model.
 * No reserved concurrency (a Workshop Studio account cannot spare one, CHANGELOG 7.23.00 Known issues): two runs at
 * once write the same whole items, so the later overwrites. No async retry: the next tick reruns a
 * day that was not written.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

import { readsCustomModelRegistry } from '../utils/custom-models';
import { logGroupArn } from '../utils/lambda-log-grants';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createDailyJob } from '../utils/worker-lambda';
import { grantWorkspaceStatusRead } from '../utils/workspace-resolution-grants';
import { WORKSPACE_ID_PATTERN } from './core-buckets';

const COST_ROLLUP_FUNCTION_BASE_NAME = 'voc-cost-rollup';
/** The cost rows' partitions in voc-aggregates (lambda/shared/platform_costs.py), one workspace id per pattern. */
export const COST_PARTITIONS = [`WS#${WORKSPACE_ID_PATTERN}#COST`, 'DEPLOYMENT#COST', 'UNATTRIBUTED#COST'];
const COST_ROLLUP_MEMORY_MB = 256;

export interface CostRollupWorkerProps {
  uniqueName: (baseName: string) => string;
  /** The deployment's Lambda log groups, `/aws/lambda/[<prefix>-]voc-*-<account>-<region>` (`uniqueNamePattern`). */
  lambdaLogGroupPattern: string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  aggregatesTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
}

/** The Logs Insights reads: list the groups, query the deployment's Lambda groups, poll and stop by query id. */
function grantUsageSearch(stack: cdk.Stack, role: iam.Role, pattern: string): void {
  const allGroups = logGroupArn(stack, '*');
  const queried = [logGroupArn(stack, pattern), logGroupArn(stack, `${pattern}:*`)];
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [allGroups] }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:StartQuery'], resources: queried }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'Cost per workspace\'s rollup: DescribeLogGroups is a list call authorized against log-group:*; StartQuery '
      + 'is limited to this deployment\'s voc-* Lambda log groups (a name pattern); GetQueryResults and StopQuery '
      + 'support no resource type; the PutItem on voc-aggregates is held to the cost partitions, one workspace id each',
    // cdk-nag reports a granted resource only when it holds a wildcard.
    findings: [...[allGroups, ...queried].filter((arn) => arn.includes('*')).map(resourceFinding), 'Resource::*'],
  }]);
}

export function createCostRollupWorker(scope: Construct, id: string, props: CostRollupWorkerProps): lambda.Function {
  // No reserved concurrency: a Workshop Studio account cannot spare one (CHANGELOG 7.23.00, Known issues), and none
  // is needed: two runs at once write the same whole items, so the later one simply overwrites.
  // A day that was not written is rerun by the next tick (it rolls up two days) or a backfill.
  // 02:15 UTC daily: yesterday is over, and the day before is rolled up again for lines that arrived late.
  const fn = createDailyJob(scope, id, props, {
    job: 'cost_rollup', baseName: COST_ROLLUP_FUNCTION_BASE_NAME, fnId: 'CostRollup', memorySize: COST_ROLLUP_MEMORY_MB,
    daily: { hour: '2', minute: '15' }, partitions: COST_PARTITIONS,
    grant: (role, worker) => {
      grantUsageSearch(cdk.Stack.of(worker), role, props.lambdaLogGroupPattern);
      grantWorkspaceStatusRead(role, props.workspacesTable);
    },
    environment: {
      AGGREGATES_TABLE: props.aggregatesTable.tableName,
      WORKSPACES_TABLE: props.workspacesTable.tableName,
      // The groups it reads, as the System logs search names them (lambda/shared/system_log_sources.py).
      SYSTEM_LOG_GROUP_PATTERN: props.lambdaLogGroupPattern,
    },
  });
  // A -c customModels model's tokens are priced from the registry (shared/model_prices.py), though the job calls no model.
  readsCustomModelRegistry(fn);
  return fn;
}
