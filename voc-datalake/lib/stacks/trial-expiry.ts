/**
 * A trial workspace's end, `voc-trial-expiry` (7.71.00; VocProcessingStack, added by bin/voc-datalake.ts through
 * {@link addTrialExpiry}, so the stack's constructor does not grow; handler lambda/jobs/trial_expiry/handler.py;
 * docs/multi-workspace.md "Trial workspaces"):
 *
 *   EventBridge rule, hourly ──{"action": "trial_expiry"}──▶ voc-trial-expiry
 *   voc-trial-expiry ──▶ one Query of the platform listing (`WORKSPACES`): the trials that are due, not paused, not
 *                        converted ──▶ each paused: its plugins' existing audited disable, its live forms off, recorded
 *
 * So a trial pauses within the hour after its end; creating, extending or converting a trial schedules nothing.
 * The job's role, pinned statement by statement with its negative pins (trial-expiry.test.ts). NO delete of any kind
 * but one: a plugin's disable IS the DeleteItem of its `PLUGIN#{plugin}` / `WS#{ws}` enable row (present = enabled;
 * the ingestors' tick fans out over those rows), the same key the existing route deletes, so that action alone, held to
 * `PLUGIN#*`. Nothing else is ever deleted: no workspace, form, response, feedback item, file or audit row.
 *   - voc-workspaces: Query of the listing partition `WORKSPACES` only (the due trials); GetItem on `WS#*`,
 *     `PLUGIN#*` and `AUDIT#WS#*` (META's trial, a plugin row, an audit row read back after a retried put); UpdateItem
 *     of `trial` alone (and the key) on META and the listing row (`WS#*`, `WORKSPACES`); PutItem of `AUDIT#WS#*` rows
 *     (the audit-row guard names this role a writer of that partition only); ConditionCheckItem on `WS#*` (the
 *     workspace is still active); DeleteItem on `PLUGIN#*` only (above);
 *   - voc-aggregates: Query and UpdateItem of a workspace's forms partition (`WS#<one id>#FEEDBACK_FORM`), the update
 *     held to `enabled`, `write_count`, `updated_at` and `updated_by`, with no values returned;
 *   - the Core key. No S3, no BatchWriteItem, no scheduler, Cognito, IAM or Lambda action, no Bedrock.
 * Fixed cost: about none (tenet 7): 720 ticks a month, each one Query of the listing partition (a few rows per
 * workspace) and nothing else while no trial is due.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { getEnabledPlugins, loadPlugins } from '../plugin-loader';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { DeploymentNaming } from '../utils/naming';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { scheduleWorker, workerRole } from '../utils/worker-lambda';
import { WORKSPACE_ID_PATTERN } from './core-buckets';

/** The job's and its hourly rule's base names. */
const TRIAL_EXPIRY_FUNCTION_BASE_NAME = 'voc-trial-expiry';
const TRIAL_EXPIRY_RULE_BASE_NAME = 'voc-trial-expiry-schedule';
/** The rule's input (lambda/jobs/trial_expiry/handler.py EXPIRY_ACTION). */
export const TRIAL_EXPIRY_INPUT = { action: 'trial_expiry' };
/** The platform listing's partition (lambda/shared/platform_workspaces.py LISTING_PK): the job's one Query there. */
const LISTING_PARTITION = 'WORKSPACES';
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
    sid: 'TrialsDue', actions: ['dynamodb:Query'], resources: [workspacesTable.tableArn],
    conditions: leadingKeys([LISTING_PARTITION]),
  }));
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
    // A tick is one Query of the listing, and a pause a few GetItems, one Query and one write per plugin and form.
    timeout: cdk.Duration.minutes(5),
    memorySize: TRIAL_EXPIRY_MEMORY_MB,
    // The rule invokes it asynchronously; Lambda's own two retries finish a tick a throttle cut short (the job is
    // idempotent, and the next tick catches up anyway).
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

  scheduleWorker(scope, 'Schedule', job, naming.uniqueName(TRIAL_EXPIRY_RULE_BASE_NAME),
    events.Schedule.rate(cdk.Duration.hours(1)), events.RuleTargetInput.fromObject(TRIAL_EXPIRY_INPUT));
  return job;
}
