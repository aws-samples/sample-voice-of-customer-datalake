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
 * Reserved concurrency 1 (free): a backfill and the tick never run at once. No async retry: the next tick reruns a
 * day that was not written.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { logGroupArn } from '../utils/lambda-log-grants';
import { LOG_RETENTION } from '../utils/log-retention';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { scheduleWorker, workerRole } from '../utils/worker-lambda';
import { grantWorkspaceStatusRead } from '../utils/workspace-resolution-grants';
import { WORKSPACE_ID_PATTERN } from './core-buckets';

const COST_ROLLUP_FUNCTION_BASE_NAME = 'voc-cost-rollup';
/** The cost rows' partitions in voc-aggregates (lambda/shared/platform_costs.py), one workspace id per pattern. */
export const COST_PARTITIONS = [`WS#${WORKSPACE_ID_PATTERN}#COST`, 'DEPLOYMENT#COST', 'UNATTRIBUTED#COST'];
/** At most one rollup at a time (reserved concurrency costs nothing). */
export const COST_ROLLUP_RESERVED_CONCURRENCY = 1;
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

/** Only `jobs/cost_rollup`, `jobs/__init__.py` and `shared/` reach this bundle (and its hash). */
function costRollupCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/cost_rollup/',
      '/aggregator/', '/api/', '/processor/', '/research/',
      ...WORKER_TREE_ASSET_EXCLUDES, ...PY_LAMBDA_ASSET_EXCLUDES,
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/cost_rollup /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
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
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, aggregatesTable, workspacesTable } = props;
  const functionName = uniqueName(COST_ROLLUP_FUNCTION_BASE_NAME);

  const role = workerRole(worker, 'CostRollupRole');
  grantUsageSearch(cdk.Stack.of(worker), role, props.lambdaLogGroupPattern);
  grantKeyScopedWrites(aggregatesTable, role, ['PutItem'], COST_PARTITIONS);
  grantWorkspaceStatusRead(role, workspacesTable);
  kmsKey.grantEncryptDecrypt(role);

  const fn = new lambda.Function(worker, 'CostRollup', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'jobs/cost_rollup/handler.lambda_handler',
    code: costRollupCode(),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: COST_ROLLUP_MEMORY_MB,
    reservedConcurrentExecutions: COST_ROLLUP_RESERVED_CONCURRENCY,
    // A day that was not written is rerun by the next tick (it rolls up two days) or a backfill.
    retryAttempts: 0,
    environment: {
      AGGREGATES_TABLE: aggregatesTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      // The groups it reads, as the System logs search names them (lambda/shared/system_log_sources.py).
      SYSTEM_LOG_GROUP_PATTERN: props.lambdaLogGroupPattern,
      POWERTOOLS_SERVICE_NAME: COST_ROLLUP_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, 'CostRollupLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  // 02:15 UTC daily: yesterday is over, and the day before is rolled up again for lines that arrived late.
  scheduleWorker(worker, 'CostRollupSchedule', fn, uniqueName('voc-cost-rollup-schedule'),
    events.Schedule.cron({ hour: '2', minute: '15' }),
    events.RuleTargetInput.fromObject({ mode: 'scheduled' }));
  return fn;
}
