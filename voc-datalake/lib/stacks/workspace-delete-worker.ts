/**
 * A workspace's hard delete, `voc-workspace-delete` (VocProcessingStack, docs/multi-workspace.md "Export and delete",
 * steps 3 and 4; handler lambda/jobs/workspace_delete/handler.py). Built like voc-workspace-export
 * (workspace-export-worker.ts): its own construct, invoked by name from the workspaces API in VocApiStack (Processing
 * deploys first; lib/stacks/api-workspace-delete.ts grants that invoke), and by itself at a hand-over.
 *
 * Its own role, exactly what its code calls (lib/stacks/workspace-delete-worker.test.ts pins every statement): the
 * sweeps' grants (lib/utils/workspace-delete-grants.ts, by sweep, each statement once), and for the job itself:
 *   - voc-workspaces: UpdateItem on its job rows (`WSDELETE`: the generation claim, the progress, the outcome), Query
 *     of a workspace's `WS#{one id}` (its META's status), PutItem and GetItem on `AUDIT#workspace-deletes` only (the
 *     completed row, read back after a retried put);
 *   - KMS (the tables' and the bucket's key), with kms:Decrypt denied where kms:ViaService is SSM; its own invoke.
 *     No Scan anywhere, no table delete, no SSM decrypt.
 *
 * Reserved concurrency 2 (free): one invocation runs per deleting workspace (the job row's generation claim), and two
 * workspaces deleting at once is far more than a deployment needs; a third waits in Lambda's throttling retries.
 * No async retry (`retryAttempts: 0`: a retried generation would race its own claim), and an invoke older than 40
 * minutes is dropped, never run late: a dropped hand-over leaves the job row's `progress_at` behind, and an hour later
 * the job reads failed and a platform admin resumes it (POST /platform/workspaces/{ws}/delete/resume).
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { byCodeUnit } from '../utils/compare';
import { WORKSPACE_DELETE_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { type DeleteGrant, deleteGrants } from '../utils/workspace-delete-grants';
import { WORKSPACE_HARD_DELETE_ENV } from '../utils/workspace-hard-delete';
import { grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { workspaceParameterEnv } from '../utils/workspace-secrets';
import { WORKSPACE_ID_PATTERN, WORKSPACE_OBJECTS_PREFIX } from './core-buckets';

/** Path-style handler: the bundle keeps `jobs/workspace_delete/` with `shared/` beside `jobs/`. */
const DELETE_HANDLER = 'jobs/workspace_delete/handler.lambda_handler';
/** At most this many deletes' invocations run at once in the deployment (reserved concurrency costs nothing). */
export const WORKSPACE_DELETE_RESERVED_CONCURRENCY = 2;
/** An invoke older than this is dropped, never run late (the header). */
export const WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES = 40;
/** Paged deletes and one tombstone put per item: I/O-bound. */
const DELETE_MEMORY_MB = 1024;
/** One workspace's partitions: every one (`#*`), and the workspace's own control partition (exactly `WS#{id}`). */
const ONE = WORKSPACE_ID_PATTERN;
const WORKSPACE_PARTITIONS = `WS#${ONE}#*`;
const WORKSPACE_CONTROL_PARTITION = `WS#${ONE}`;
/** The delete's job rows and the platform's delete audit partition in voc-workspaces (shared/workspace_deletes.py). */
export const DELETE_JOB_PARTITION = 'WSDELETE';
export const DELETE_AUDIT_PARTITION = 'AUDIT#workspace-deletes';
/** Where every tombstone lives in voc-aggregates (shared/ws_repo.py TOMBSTONE_PARTITION_PREFIX). */
export const TOMBSTONE_PARTITIONS = 'AUDIT#tombstone#*';
/** The control-plane rows of a workspace the job deletes (shared/ws_repo.py WorkspaceControlRows): its own
 * partition, its members' inverse rows, its forms' lookup rows, its plugin rows and its listing row. IAM pins only the
 * partition, so USER#*, FORM#*, PLUGIN#* and WORKSPACES reach other workspaces' rows too: the code builds the sort
 * key (`WS#{ws}`) or deletes only a row naming this workspace (`workspace_id`), tested. */
export const CONTROL_ROW_DELETES = [WORKSPACE_CONTROL_PARTITION, 'FORM#*', 'PLUGIN#*', 'USER#*', 'WORKSPACES'];
/** The indexes the sweeps read (lambda/shared/indexes.py). */
const FEEDBACK_BY_DATE_INDEX = 'gsi1-by-date';
const AGGREGATES_BY_METRIC_TYPE_INDEX = 'gsi1-by-metric-type';
const MEMORY_BY_STATUS_INDEX = 'gsi1-by-memory-status';
/** The memory partitions read by their own key (the personal memories through the status index). */
export const MEMORY_PARTITIONS = [`WS#${ONE}#MEM#company`, `WS#${ONE}#MEMCURSOR`, `WS#${ONE}#MEMIMPORT`,
  `WS#${ONE}#MEMEVT#*`];

export interface WorkspaceDeleteWorkerProps {
  uniqueName: (baseName: string) => string;
  /** The deployment-prefixed base path of the workspaces' credentials parameters (`ctx.prefixed('voc/ws')`). */
  parameterBasePath: string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
  memoryTable: dynamodb.ITable;
  watermarksTable: dynamodb.ITable;
  /** voc-radar: a workspace's Radar settings (`WS#{id}#SETTINGS#radar`). */
  radarTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
  /** Every plugin id of the deployment (its PLUGIN#{p} rows and per-plugin partitions are found by them). */
  pluginIds: readonly string[];
}

const keys = (partitions: readonly string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...partitions] } });

/** One Query (and reads) statement on a table or one of its indexes, held to `partitions`. */
function query(role: iam.Role, sid: string, resource: string, partitions: readonly string[], actions = ['dynamodb:Query']): void {
  role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources: [resource], conditions: keys(partitions) }));
}

/**
 * Staged from `lambda/`, pruned to `jobs/workspace_delete`, the export's page helpers (`jobs/workspace_export/
 * pages.py`, which the sweeps share), `aggregator/` (its counter key function, read as
 * scripts/retention/rebuild_aggregates.py reads it) and `shared/`.
 */
function deleteCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/workspace_delete/', '!/jobs/workspace_export/',
      '/jobs/workspace_export/*', '!/jobs/workspace_export/__init__.py', '!/jobs/workspace_export/pages.py',
    ],
    copy: [
      'mkdir -p /asset-output/jobs/workspace_export',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/workspace_delete /asset-output/jobs/',
      'cp /asset-input/jobs/workspace_export/__init__.py /asset-input/jobs/workspace_export/pages.py '
        + '/asset-output/jobs/workspace_export/',
      'cp -r /asset-input/aggregator /asset-output/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/** The `credentials` grant: one workspace's credentials path listed and its parameters deleted, never read. */
function grantCredentials(stack: cdk.Stack, role: iam.Role, parameterBasePath: string): void {
  const path = `${parameterBasePath}/${ONE}/credentials`;
  const arn = (name: string) => stack.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name,
    arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME });
  // Listed WithDecryption=False, and kms:Decrypt through SSM denied outright (the role's kmsKey grant would
  // otherwise allow it, should the parameters ever share that key): no value can be read.
  role.addToPolicy(new iam.PolicyStatement({ sid: 'ListWorkspaceCredentials', actions: ['ssm:GetParametersByPath'],
    resources: [arn(path)] }));
  role.addToPolicy(new iam.PolicyStatement({ sid: 'DeleteWorkspaceCredentials', actions: ['ssm:DeleteParameters'],
    resources: [arn(`${path}/*`)] }));
  role.addToPolicy(new iam.PolicyStatement({ sid: 'NoDecryptThroughSsm', effect: iam.Effect.DENY,
    actions: ['kms:Decrypt'], resources: ['*'],
    conditions: { StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` } } }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'A workspace\'s hard delete deletes that workspace\'s plugin credentials parameters (voc/ws/{ws}/'
      + 'credentials/{plugin}, decision 19), the path built from the job row\'s workspace only; one workspace id '
      + 'segment of this deployment\'s path, listed without decryption, kms:Decrypt through SSM denied',
    findings: [resourceFinding(arn(`${path}/*`))],
  }]);
}

/** The grants on voc-aggregates (lib/utils/workspace-delete-grants.ts); false for a grant on another resource. */
function grantOnAggregates(role: iam.Role, which: DeleteGrant, aggregatesTable: dynamodb.ITable): boolean {
  switch (which) {
    case 'aggregates':
      query(role, 'ReadWorkspaceAggregates', aggregatesTable.tableArn, [WORKSPACE_PARTITIONS],
        ['dynamodb:GetItem', 'dynamodb:Query']);
      grantKeyScopedWrites(aggregatesTable, role, ['BatchWriteItem'], [WORKSPACE_PARTITIONS]);
      return true;
    case 'metricTypeIndex':
      query(role, 'QueryWorkspaceMetricTypes', `${aggregatesTable.tableArn}/index/${AGGREGATES_BY_METRIC_TYPE_INDEX}`,
        [WORKSPACE_PARTITIONS]);
      return true;
    case 'tombstones':
      grantKeyScopedWrites(aggregatesTable, role, ['PutItem'], [TOMBSTONE_PARTITIONS]);
      return true;
    case 'exportJobs':
      grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], [`WS#${ONE}#JOB#export`]);
      return true;
    default:
      return false;
  }
}

/** Each grant's statements (lib/utils/workspace-delete-grants.ts). */
function grant(scope: Construct, role: iam.Role, which: DeleteGrant, props: WorkspaceDeleteWorkerProps): void {
  const { feedbackTable, aggregatesTable, workspacesTable, memoryTable, watermarksTable, radarTable, rawDataBucket } = props;
  if (grantOnAggregates(role, which, aggregatesTable)) return;
  switch (which) {
    case 'feedback':
      query(role, 'QueryWorkspaceFeedbackByDate', `${feedbackTable.tableArn}/index/${FEEDBACK_BY_DATE_INDEX}`,
        [`WS#${ONE}#DATE#*`]);
      query(role, 'QueryWorkspaceFeedback', feedbackTable.tableArn, [`WS#${ONE}#SOURCE#*`]);
      grantKeyScopedWrites(feedbackTable, role, ['BatchWriteItem'], [`WS#${ONE}#SOURCE#*`]);
      return;
    case 'watermarks':
      grantKeyScopedWrites(watermarksTable, role, ['BatchWriteItem'], [WORKSPACE_PARTITIONS]);
      return;
    case 'radar':
      // The workspace's Radar rows (sweeps.py `radar`): read and batch-deleted in its own partitions only.
      query(role, 'ReadWorkspaceRadar', radarTable.tableArn, [WORKSPACE_PARTITIONS], ['dynamodb:GetItem', 'dynamodb:Query']);
      grantKeyScopedWrites(radarTable, role, ['BatchWriteItem'], [WORKSPACE_PARTITIONS]);
      return;
    case 'memory':
      query(role, 'QueryWorkspaceMemory', memoryTable.tableArn, MEMORY_PARTITIONS);
      query(role, 'QueryWorkspacePersonalMemories', `${memoryTable.tableArn}/index/${MEMORY_BY_STATUS_INDEX}`,
        [`WS#${ONE}#MEMSTATUS#personal#*`]);
      grantKeyScopedWrites(memoryTable, role, ['BatchWriteItem'], [WORKSPACE_PARTITIONS]);
      return;
    case 'objects': {
      const versionsOfOneWorkspace = { StringLike: { 's3:prefix': [WORKSPACE_OBJECTS_PREFIX] } };
      // ListBucketMultipartUploads takes no s3:prefix condition: upload keys and ids only, no data; the code lists
      // one workspace's prefix (shared/ws_repo.py WorkspaceObjectVersions.open_uploads).
      const statements: [string, string[], string, Record<string, unknown> | undefined][] = [
        ['ListWorkspaceObjectVersions', ['s3:ListBucketVersions'], rawDataBucket.bucketArn, versionsOfOneWorkspace],
        ['ListOpenUploads', ['s3:ListBucketMultipartUploads'], rawDataBucket.bucketArn, undefined],
        ['DeleteWorkspaceObjectVersions', ['s3:AbortMultipartUpload', 's3:DeleteObjectVersion'],
          rawDataBucket.arnForObjects(WORKSPACE_OBJECTS_PREFIX), undefined],
      ];
      for (const [sid, actions, resource, conditions] of statements) {
        role.addToPolicy(new iam.PolicyStatement({ sid, actions, resources: [resource], conditions }));
      }
      return;
    }
    case 'credentials':
      grantCredentials(cdk.Stack.of(scope), role, props.parameterBasePath);
      return;
    case 'controlRows':
      query(role, 'QueryWorkspaceControlPartition', workspacesTable.tableArn, [WORKSPACE_CONTROL_PARTITION]);
      grantKeyScopedWrites(workspacesTable, role, ['DeleteItem'], CONTROL_ROW_DELETES);
      grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], ['SLUG#*'], ['deleted_at', 'pk', 'sk', 'workspace_id']);
      break;
    default:
      // The voc-aggregates grants (grantOnAggregates, above).
  }
}

/** The delete job (see the module comment). */
export function createWorkspaceDeleteWorker(scope: Construct, id: string,
  props: WorkspaceDeleteWorkerProps): lambda.Function {
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, workspacesTable } = props;
  const functionName = uniqueName(WORKSPACE_DELETE_FUNCTION_BASE_NAME);
  const role = workerRole(worker, 'DeleteRole');
  for (const which of deleteGrants()) grant(worker, role, which, props);
  // The job's own row, its META check and its completed audit row (shared/workspace_deletes.py).
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], [DELETE_JOB_PARTITION]);
  grantKeyScopedWrites(workspacesTable, role, ['PutItem'], [DELETE_AUDIT_PARTITION]);
  query(role, 'ReadDeleteAuditRows', workspacesTable.tableArn, [DELETE_AUDIT_PARTITION], ['dynamodb:GetItem']);
  kmsKey.grantEncryptDecrypt(role);
  grantInvokeByName(cdk.Stack.of(worker), role, [functionName], 'SelfInvoke');

  return new lambda.Function(worker, 'Delete', {
    functionName,
    role,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: DELETE_HANDLER,
    code: deleteCode(),
    layers: [props.layer],
    timeout: cdk.Duration.minutes(15),
    memorySize: DELETE_MEMORY_MB,
    reservedConcurrentExecutions: WORKSPACE_DELETE_RESERVED_CONCURRENCY,
    // A hidden re-drive would race the generation claim; a stale event is dropped, not run late.
    retryAttempts: 0,
    maxEventAge: cdk.Duration.minutes(WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES),
    environment: {
      FEEDBACK_TABLE: props.feedbackTable.tableName,
      AGGREGATES_TABLE: props.aggregatesTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      MEMORY_TABLE: props.memoryTable.tableName,
      WATERMARKS_TABLE: props.watermarksTable.tableName,
      RADAR_TABLE: props.radarTable.tableName,
      RAW_DATA_BUCKET: props.rawDataBucket.bucketName,
      PLUGIN_IDS: JSON.stringify([...props.pluginIds].sort(byCodeUnit)),
      // Built only with the flag on (lib/utils/workspace-hard-delete.ts); the job refuses to run without it.
      [WORKSPACE_HARD_DELETE_ENV]: 'true',
      ...workspaceParameterEnv(props.parameterBasePath),
      POWERTOOLS_SERVICE_NAME: WORKSPACE_DELETE_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    logGroup: new logs.LogGroup(worker, 'DeleteLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}
