/**
 * A trial workspace's end, `voc-trial-expiry` (7.71.00; VocProcessingStack, added by bin/voc-datalake.ts through
 * {@link addTrialExpiry}, so the stack's constructor does not grow; handler lambda/jobs/trial_expiry/handler.py;
 * docs/multi-workspace.md "Trial workspaces"):
 *
 *   POST /platform/workspaces {trial} or …/trial/extend (the workspaces API) ──▶ scheduler:CreateSchedule
 *                       voc-trial-<ws>-<end> in this group (one per trial and end, deleting itself once it has run)
 *   EventBridge Scheduler ──(its own role: invoke this job, nothing else)──▶ voc-trial-expiry, once
 *   voc-trial-expiry ──▶ the trial paused: its plugins' existing audited disable, its live forms off, all recorded
 *
 * The job's role, pinned statement by statement with its negative pins (trial-expiry.test.ts). NO delete of any kind
 * but one: a plugin's disable IS the DeleteItem of its `PLUGIN#{plugin}` / `WS#{ws}` enable row (present = enabled;
 * the ingestors' tick fans out over those rows), the same key the existing route deletes, so that action alone, held to
 * `PLUGIN#*`. Nothing else is ever deleted: no workspace, form, response, feedback item, file or audit row.
 *   - voc-workspaces: GetItem on `WS#*`, `PLUGIN#*` and `AUDIT#WS#*` (META's trial, a plugin row, an audit row read
 *     back after a retried put); UpdateItem of `trial` alone (and the key) on META and the listing row (`WS#*`,
 *     `WORKSPACES`); PutItem of `AUDIT#WS#*` rows (the audit-row guard names this role a writer of that partition only);
 *     ConditionCheckItem on `WS#*` (the workspace is still active); DeleteItem on `PLUGIN#*` only (above);
 *   - voc-aggregates: Query and UpdateItem of a workspace's forms partition (`WS#<one id>#FEEDBACK_FORM`), the update
 *     held to `enabled`, `write_count`, `updated_at` and `updated_by`, with no values returned;
 *   - the Core key. No S3, no BatchWriteItem, no scheduler, Cognito, IAM or Lambda action, no Bedrock.
 * The scheduler's role: assumed by EventBridge Scheduler for this account and this group only; `lambda:InvokeFunction`
 * on this job alone. The workspaces API (lib/stacks/api-workspaces-lambda.ts `grantTrialSchedules`) holds
 * `scheduler:CreateSchedule` on this group's `voc-trial-*` names and `iam:PassRole` of the scheduler's role only. Both
 * sides build the names from the same base names (as the category reprocess worker's), so no cross-stack export is
 * pinned and VocApiStack gains no resource.
 * Fixed cost: none (tenet 7). The group and its schedules cost nothing until a schedule runs, once per trial end.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';

import { getEnabledPlugins, loadPlugins } from '../plugin-loader';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { DeploymentNaming } from '../utils/naming';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { workerRole } from '../utils/worker-lambda';
import { WORKSPACE_ID_PATTERN } from './core-buckets';

/** The job's, the scheduler role's and the group's base names (the workspaces API builds the same three). */
export const TRIAL_EXPIRY_FUNCTION_BASE_NAME = 'voc-trial-expiry';
export const TRIAL_SCHEDULER_ROLE_BASE_NAME = 'voc-trial-scheduler';
export const TRIAL_SCHEDULE_GROUP_BASE_NAME = 'voc-trials';
/** Every trial schedule's name starts so (lambda/shared/trial_schedule.py SCHEDULE_PREFIX, held equal by a test). */
export const TRIAL_SCHEDULE_PREFIX = 'voc-trial-';
/** The construct id under the stack (the audit-row guard names the role by its path, lib/utils/audit-row-guard.ts). */
const TRIAL_EXPIRY_ID = 'TrialExpiry';
/** A workspace's forms partition in voc-aggregates (lambda/shared/onboarding.py forms_partition), one id per pattern. */
export const TRIAL_FORM_PARTITIONS = [`WS#${WORKSPACE_ID_PATTERN}#FEEDBACK_FORM`];
/** What a pause or a resume writes on a form (lambda/shared/trial_pause.py set_form_live), with the key. */
export const TRIAL_FORM_ATTRIBUTES = ['enabled', 'pk', 'sk', 'updated_at', 'updated_by', 'write_count'];
/** What a trial write touches on META and the listing row (lambda/shared/trials.py save_trial), with the key. */
export const TRIAL_ATTRIBUTES = ['pk', 'sk', 'trial'];
/** The VocProcessingStack layer the job runs on (processing-stack-consolidated.ts `dependencyLayer`). */
const PROCESSING_LAYER_ID = 'ProcessingDepsLayer';
const TRIAL_EXPIRY_MEMORY_MB = 256;
const PLUGINS_DIR = path.join(__dirname, '../../plugins');

export interface TrialExpiryProps {
  readonly deploymentPrefix?: string;
  readonly workspacesTable: dynamodb.ITable;
  readonly aggregatesTable: dynamodb.ITable;
  readonly kmsKey: kms.IKey;
  /** The deployment's enabled plugins (pluginStatus): the ceiling of a workspace's plugins, as the workspaces API's. */
  readonly enabledSources: readonly string[];
  /** The layer to run on; by default the stack's own processing layer. */
  readonly layer?: lambda.ILayerVersion;
}

/** Only `jobs/trial_expiry`, `jobs/__init__.py` and `shared/` reach this bundle (and its hash). */
function trialExpiryCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/trial_expiry/',
      '/aggregator/', '/api/', '/processor/', '/research/',
      ...WORKER_TREE_ASSET_EXCLUDES, ...PY_LAMBDA_ASSET_EXCLUDES,
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/trial_expiry /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

const leadingKeys = (partitions: readonly string[]) => ({
  'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] },
});

/** The job's reads and writes (see the module's doc). */
function grantPause(role: iam.Role, props: TrialExpiryProps): void {
  const { workspacesTable, aggregatesTable } = props;
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'TrialReads', actions: ['dynamodb:GetItem'], resources: [workspacesTable.tableArn],
    conditions: leadingKeys(['AUDIT#WS#*', 'PLUGIN#*', 'WS#*']),
  }));
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['WORKSPACES', 'WS#*'], TRIAL_ATTRIBUTES,
    { noReturnValues: true });
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], ['AUDIT#WS#*']);
  // The existing plugin disable: the delete of a PLUGIN#{plugin} / WS#{ws} enable row, and nothing else.
  grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], ['PLUGIN#*']);
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'TrialActiveCheck', actions: ['dynamodb:ConditionCheckItem'], resources: [workspacesTable.tableArn],
    conditions: leadingKeys(['WS#*']),
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'TrialFormsList', actions: ['dynamodb:Query'], resources: [aggregatesTable.tableArn],
    conditions: leadingKeys(TRIAL_FORM_PARTITIONS),
  }));
  grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], TRIAL_FORM_PARTITIONS, TRIAL_FORM_ATTRIBUTES,
    { noReturnValues: true });
  props.kmsKey.grantEncryptDecrypt(role);
}

/** The scheduler's own role: assumed by EventBridge Scheduler for this account's trials group only; it may invoke the
 *  job and nothing else. */
function schedulerRole(scope: Construct, name: string, groupArn: string, job: lambda.IFunction): iam.Role {
  const role = new iam.Role(scope, 'SchedulerRole', {
    roleName: name,
    assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(scope).account }, ArnEquals: { 'aws:SourceArn': groupArn } },
    }),
    description: 'EventBridge Scheduler: runs the trial expiry job once at a trial workspace\'s end, nothing else',
  });
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'InvokeTheTrialExpiry', actions: ['lambda:InvokeFunction'], resources: [job.functionArn],
  }));
  return role;
}

/** The stack's processing layer (or the one given). */
function layerOf(stack: cdk.Stack, given: lambda.ILayerVersion | undefined): lambda.ILayerVersion {
  if (given !== undefined) return given;
  const found = stack.node.tryFindChild(PROCESSING_LAYER_ID);
  if (!(found instanceof lambda.LayerVersion)) throw new Error(`${stack.stackName} has no ${PROCESSING_LAYER_ID} to run voc-trial-expiry on`);
  return found;
}

/** The trial expiry (see the module's doc) on `stack`; the job. */
export function addTrialExpiry(stack: cdk.Stack, props: TrialExpiryProps): lambda.Function {
  const scope = new Construct(stack, TRIAL_EXPIRY_ID);
  const naming = new DeploymentNaming(stack, props.deploymentPrefix);
  const functionName = naming.uniqueName(TRIAL_EXPIRY_FUNCTION_BASE_NAME);
  const groupName = naming.uniqueName(TRIAL_SCHEDULE_GROUP_BASE_NAME);

  const role = workerRole(scope, 'Role');
  grantPause(role, props);
  const plugins = getEnabledPlugins(loadPlugins(PLUGINS_DIR), [...props.enabledSources]).map((plugin) => plugin.id);
  const job = new lambda.Function(scope, 'Job', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: 'jobs/trial_expiry/handler.lambda_handler',
    code: trialExpiryCode(),
    role,
    // A pause is a few GetItems, one Query and one write per plugin and live form.
    timeout: cdk.Duration.minutes(5),
    memorySize: TRIAL_EXPIRY_MEMORY_MB,
    // Scheduler invokes it asynchronously and retries a failed invoke itself; Lambda's own two retries finish a pause
    // a throttle cut short (the job is idempotent).
    retryAttempts: 2,
    environment: {
      WORKSPACES_TABLE: props.workspacesTable.tableName,
      AGGREGATES_TABLE: props.aggregatesTable.tableName,
      ENABLED_SOURCES: JSON.stringify(plugins),
      POWERTOOLS_SERVICE_NAME: TRIAL_EXPIRY_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [layerOf(stack, props.layer)],
    logGroup: new logs.LogGroup(scope, 'Logs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  new scheduler.CfnScheduleGroup(scope, 'Schedules', { name: groupName });
  const groupArn = stack.formatArn({
    service: 'scheduler', resource: 'schedule-group', resourceName: groupName, arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
  });
  schedulerRole(scope, naming.uniqueName(TRIAL_SCHEDULER_ROLE_BASE_NAME), groupArn, job);
  return job;
}
