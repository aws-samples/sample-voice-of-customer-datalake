/**
 * The scheduled cross-run Learn pass (7.53.00; lambda/engineering/learning/cross_run.py, docs/autonomous-engineering.md
 * "The scheduled cross-run Learn pass"), in the engineering runtime (only with `-c engineeringAgents=true`):
 *
 *   EventBridge Scheduler, weekly (Mondays 06:00 UTC), DISABLED unless -c engineeringCrossRunLearn=weekly
 *     ──(its own role: invoke the runtime, nothing else)──▶ voc-engineering-runtime {action: learn_cross_run}
 *   voc-engineering-runtime ──▶ itself, one asynchronous invocation per flow {action: learn_cross_run, flow}
 *
 * The grants, on the runtime's role (beside Learn's own, engineering-runtime.ts grantLearning and grantRunEnd):
 * - `s3:ListBucket` on the workspace bucket with `s3:prefix` held to the transcripts' index (`CrossRunListsIndex`): the
 *   index's flows, a flow's days and a day's runs, by prefix only;
 * - `s3:GetObject` on the runs' manifests (`CrossRunReadsManifests`), read only (a manifest's key is the layout's, never
 *   listed);
 * - `s3:PutObject` on `ws/default/learn/*` (`CrossRunRecords`): a flow's weekly record, create-only (the bucket refuses
 *   a put without If-None-Match);
 * - `dynamodb:GetItem`, `PutItem` and `UpdateItem` on the flows' cross-run partitions only (`WS#*#LEARN#*`,
 *   `CrossRunRows`): the week's claim and outcome (create-only in code) and the month's spend (ADD); never a delete.
 * The model call (Converse on the allowlisted models), the spend ledger's ADDs and a flow's month total, the skills',
 * the roles' lessons' and the runs' rows, the gate records and the invoke of itself are grants it holds already. No
 * agent role and no API role gains anything here. A schedule costs nothing while it is disabled, and one invocation a
 * week, plus one per flow, when it is enabled (tenet 7).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import type { Construct } from 'constructs';

import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { ENGINEERING_WORKSPACE } from './core-buckets';

/** The CDK context key that enables the weekly schedule (`weekly`; anything but `off` or nothing fails the synth). */
const CROSS_RUN_CONTEXT_KEY = 'engineeringCrossRunLearn';
/** The schedule's cron (UTC): Mondays at 06:00, the first hours of the ISO week the pass keys its record by. */
export const CROSS_RUN_SCHEDULE = 'cron(0 6 ? * MON *)';
/** The transcripts' index (lambda/engineering/runtime/manifest.py index_key), which the pass lists by prefix. */
export const CROSS_RUN_INDEX_PREFIX = `ws/${ENGINEERING_WORKSPACE}/transcripts-index/*`;
/** A run's manifests (runtime/manifest.py manifest_key). */
const MANIFEST_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/_manifest/*`;
/** The flows' weekly records (learning/cross_run.py record_key). */
export const CROSS_RUN_RECORD_KEYS = `ws/${ENGINEERING_WORKSPACE}/learn/*`;
/** The flows' cross-run partitions (learning/cross_run.py learn_pk). */
export const CROSS_RUN_PARTITIONS = 'WS#*#LEARN#*';

/** `-c engineeringCrossRunLearn`: `weekly` enables the schedule; nothing, '' or `off` leaves it disabled. */
function crossRunEnabled(scope: Construct): boolean {
  const raw: unknown = scope.node.tryGetContext(CROSS_RUN_CONTEXT_KEY);
  if (raw === undefined || raw === null || raw === '' || raw === 'off') return false;
  if (raw === 'weekly') return true;
  throw new Error(`-c ${CROSS_RUN_CONTEXT_KEY} is weekly or off (off by default).`);
}

export interface CrossRunProps {
  uniqueName: (baseName: string) => string;
  /** voc-engineering-runtime and its role. */
  runtime: lambda.IFunction;
  runtimeRole: iam.Role;
  engineeringTable: dynamodb.ITable;
  workspaceBucket: s3.IBucket;
}

/** The runtime role's grants for the pass (see the module's doc). */
function grantPass(props: CrossRunProps): void {
  const { runtimeRole: role, workspaceBucket: bucket } = props;
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CrossRunListsIndex', actions: ['s3:ListBucket'], resources: [bucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [CROSS_RUN_INDEX_PREFIX] } },
  }));
  // (the manifests' keys are acknowledged with the run's end's grant on them, engineering-runtime-grants.ts)
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CrossRunReadsManifests', actions: ['s3:GetObject'], resources: [bucket.arnForObjects(MANIFEST_KEYS)],
  }));
  const records = bucket.arnForObjects(CROSS_RUN_RECORD_KEYS);
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'CrossRunRecords', actions: ['s3:PutObject'], resources: [records] }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'The flows\' weekly cross-run Learn records (one per flow and ISO week, known only at run time), create-only',
    findings: [resourceFinding(records)],
  }]);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CrossRunRows', actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [props.engineeringTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [CROSS_RUN_PARTITIONS] } },
  }));
}

/**
 * The pass's weekly schedule, its own role (assumed by EventBridge Scheduler for this account and this schedule
 * only; it may invoke the runtime and nothing else), and the runtime role's grants. The schedule is created DISABLED
 * unless `-c engineeringCrossRunLearn=weekly`; it never retries (a missed week is the next week's).
 */
export function grantCrossRunLearn(scope: Construct, props: CrossRunProps): scheduler.CfnSchedule {
  const stack = cdk.Stack.of(scope);
  const name = props.uniqueName('voc-eng-cross-run-learn');
  const scheduleArn = stack.formatArn({
    service: 'scheduler', resource: 'schedule', resourceName: `default/${name}`, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  const invoker = new iam.Role(scope, 'EngineeringCrossRunSchedulerRole', {
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': stack.account }, ArnEquals: { 'aws:SourceArn': scheduleArn } },
    }),
  });
  invoker.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'InvokeTheRuntime', actions: ['lambda:InvokeFunction'], resources: [props.runtime.functionArn],
  }));
  grantPass(props);
  return new scheduler.CfnSchedule(scope, 'EngineeringCrossRunLearnSchedule', {
    name,
    description: 'The weekly cross-run Learn pass: proposals only, which a person accepts.',
    scheduleExpression: CROSS_RUN_SCHEDULE,
    scheduleExpressionTimezone: 'UTC',
    flexibleTimeWindow: { mode: 'OFF' },
    state: crossRunEnabled(scope) ? 'ENABLED' : 'DISABLED',
    target: {
      arn: props.runtime.functionArn,
      roleArn: invoker.roleArn,
      input: JSON.stringify({ action: 'learn_cross_run' }),
      retryPolicy: { maximumRetryAttempts: 0 },
    },
  });
}
