/**
 * A workspace's export job, `voc-workspace-export` (VocProcessingStack, docs/multi-workspace.md "Export and delete",
 * step 2; handler lambda/jobs/workspace_export/handler.py). Built like voc-retention (retention-worker.ts): on its
 * own construct, invoked by name from the workspaces API in VocApiStack (Processing deploys first, so a construct
 * reference would be a cycle; lib/stacks/api-workspace-export.ts grants that invoke), and by itself at a hand-over.
 *
 * Its own role, exactly what its code calls (lib/stacks/workspace-export-worker.test.ts pins it):
 *   - voc-feedback: Query of `gsi1-by-date` only, where the index partition is one workspace's day
 *     (`dynamodb:LeadingKeys` `WS#{one id}#DATE#*`); no table read, no Scan;
 *   - voc-aggregates: GetItem and Query where the partition is one workspace's (`WS#{one id}#*`), and UpdateItem
 *     only on its export jobs and lock (`WS#{one id}#JOB#export`); no PutItem, DeleteItem or BatchWriteItem;
 *   - voc-workspaces: Query only, of a workspace's `WS#{one id}` and `AUDIT#WS#{one id}`; no write;
 *   - the raw data bucket, under `ws/{one id}/exports/*` only: PutObject, PutObjectTagging, GetObject,
 *     AbortMultipartUpload and ListMultipartUploadParts, and DeleteObject on `…/exports/*\/work/*` only (the work
 *     objects of an export that may not go on);
 *   - the workspace's own objects (slice 4b), read-only: `s3:ListBucket` only with the `s3:prefix` `ws/{one id}/*`,
 *     and `s3:GetObject` on `ws/{one id}/*` (its raw/, silver/ and any other folder; the code skips its exports and
 *     refuses another workspace's key); no write, tag or delete there;
 *   - KMS; its own invoke; the `jobs` channel's publish (processing-stack-consolidated.ts); no SSM and no Secrets
 *     Manager: a workspace's credentials are never exported.
 *
 * Reserved concurrency 10 (free: it only caps the function's share and guarantees it, tenet 7). Why 10: the
 * workspace's export lock already allows one export per workspace, and each export runs one invocation at a time
 * (two for the seconds of a hand-over, while the next starts and the last returns), so 10 lets about five
 * workspaces export at once before an invoke is throttled, which makes throttling rare, and it keeps the account's
 * quota need small (the MCP endpoint's 20 + these 10 + the 100 Lambda keeps unreserved: 130, docs/deployment.md).
 * No async retry (`retryAttempts: 0`: a retried generation would race its own claim). A throttled invoke is retried
 * by Lambda for up to 40 minutes (`maxEventAge`), then dropped: 40 minutes of waiting plus a 15-minute invocation
 * stay inside the lock's hour (`STALE_AFTER`, lambda/shared/source_erasure.py; the claim's freshness,
 * lambda/shared/export_jobs.py `claim_generation`), so a late invoke never runs beside an export that took the
 * workspace's freed lock. A dropped invoke is never silent: past that hour the lock is stale (a new start works) and
 * the API shows the export failed (`job_view`), "The export did not start" for a start, "The export stopped before
 * it finished" for a hand-over.
 */
import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { WORKSPACE_EXPORT_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { LOG_RETENTION } from '../utils/log-retention';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { grantInvokeByName, workerRole } from '../utils/worker-lambda';
import { WORKSPACE_EXPORTS_PREFIX, WORKSPACE_ID_PATTERN, WORKSPACE_OBJECTS_PREFIX } from './core-buckets';

/** Path-style handler: the bundle keeps `jobs/workspace_export/` with `shared/` beside `jobs/`. */
const EXPORT_HANDLER = 'jobs/workspace_export/handler.lambda_handler';
/** At most this many exports run at once in the deployment (reserved concurrency costs nothing). */
export const WORKSPACE_EXPORT_RESERVED_CONCURRENCY = 10;
/** An invoke (a start or a hand-over) older than this is dropped, never run late: with the 15-minute timeout it
 *  stays 5 minutes inside the lock's hour (the header). */
export const WORKSPACE_EXPORT_MAX_EVENT_AGE_MINUTES = 40;
/** One vCPU (the Python cap, lib/sizing/policy.ts): DEFLATE is CPU-bound, and a 64 MB part is buffered. */
const EXPORT_MEMORY_MB = 1769;
/** The index the job reads a workspace's feedback through, by day (lambda/shared/indexes.py). */
const FEEDBACK_BY_DATE_INDEX = 'gsi1-by-date';
/** A workspace's export jobs and their lock in voc-aggregates (lambda/shared/export_jobs.py). */
export const EXPORT_JOB_PARTITION = `WS#${WORKSPACE_ID_PATTERN}#JOB#export`;
/** One workspace's day partitions of that index. */
export const WORKSPACE_DATE_PARTITIONS = `WS#${WORKSPACE_ID_PATTERN}#DATE#*`;
/** Every partition of one workspace in voc-aggregates. */
const WORKSPACE_AGGREGATE_PARTITIONS = `WS#${WORKSPACE_ID_PATTERN}#*`;
/** A workspace's two control-plane partitions in voc-workspaces (lambda/shared/ws_repo.py `control_query`). */
export const CONTROL_PARTITIONS = [`WS#${WORKSPACE_ID_PATTERN}`, `AUDIT#WS#${WORKSPACE_ID_PATTERN}`];
/** What the job does to the objects under a workspace's exports. */
const EXPORT_OBJECT_ACTIONS = ['s3:PutObject', 's3:PutObjectTagging', 's3:GetObject', 's3:AbortMultipartUpload',
  's3:ListMultipartUploadParts'];

export interface WorkspaceExportWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  workspacesTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
}

/**
 * Staged from `lambda/`, pruned to `jobs/workspace_export`, `jobs/__init__.py` and `shared/` (as voc-retention's
 * bundle is), so no other job, API handler or worker tree moves this hash.
 */
function exportCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/aggregator/', '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/workspace_export/',
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/workspace_export /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

/** The export job (see the module comment); the caller wires its job notice (`grantRealtimePublish`). */
export function createWorkspaceExportWorker(scope: Construct, id: string,
  props: WorkspaceExportWorkerProps): lambda.Function {
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, feedbackTable, aggregatesTable, workspacesTable, rawDataBucket } = props;
  const functionName = uniqueName(WORKSPACE_EXPORT_FUNCTION_BASE_NAME);
  const role = workerRole(worker, 'ExportRole');
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'QueryFeedbackByDate',
    actions: ['dynamodb:Query'],
    resources: [`${feedbackTable.tableArn}/index/${FEEDBACK_BY_DATE_INDEX}`],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [WORKSPACE_DATE_PARTITIONS] } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'ReadWorkspaceAggregates',
    actions: ['dynamodb:GetItem', 'dynamodb:Query'],
    resources: [aggregatesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [WORKSPACE_AGGREGATE_PARTITIONS] } },
  }));
  grantKeyScopedWrites(aggregatesTable, role, ['UpdateItem'], [EXPORT_JOB_PARTITION]);
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'QueryWorkspaceControlPlane',
    actions: ['dynamodb:Query'],
    resources: [workspacesTable.tableArn],
    conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': CONTROL_PARTITIONS } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'WriteWorkspaceExports',
    actions: EXPORT_OBJECT_ACTIONS,
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`)],
  }));
  // An export that may not go on (its row erased, or held by another invocation) deletes the work objects it wrote:
  // `{export id}/work/*` only, never a zip (the key must hold `/work/` after the export's folder).
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'DeleteWorkspaceExportWorkObjects',
    actions: ['s3:DeleteObject'],
    resources: [rawDataBucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*/work/*`)],
  }));
  // Slice 4b: the workspace's own objects into its zip (lambda/jobs/workspace_export/objects.py), read-only. The
  // listing names `ws/{one id}/` as its prefix (lambda/shared/ws_repo.py `WorkspaceObjects`, which refuses any other
  // key and skips the exports), and a read reaches one workspace's keys only; the event names the workspace.
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'ListWorkspaceObjects',
    actions: ['s3:ListBucket'],
    resources: [rawDataBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [WORKSPACE_OBJECTS_PREFIX] } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'ReadWorkspaceObjects',
    actions: ['s3:GetObject'],
    resources: [rawDataBucket.arnForObjects(WORKSPACE_OBJECTS_PREFIX)],
  }));
  // Encrypt for the zip and its work objects; decrypt for those and for the workspace's objects (SSE-KMS, through S3).
  kmsKey.grantEncryptDecrypt(role);
  // The hand-over before the 15-minute ceiling, by name (a GetAtt from its own role would be a cycle).
  grantInvokeByName(cdk.Stack.of(worker), role, [functionName], 'SelfInvoke');

  return new lambda.Function(worker, 'Export', {
    functionName,
    role,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: EXPORT_HANDLER,
    code: exportCode(),
    layers: [props.layer],
    timeout: cdk.Duration.minutes(15),
    memorySize: EXPORT_MEMORY_MB,
    reservedConcurrentExecutions: WORKSPACE_EXPORT_RESERVED_CONCURRENCY,
    // A hidden re-drive would race the generation claim; a stale event is dropped, not run late.
    retryAttempts: 0,
    maxEventAge: cdk.Duration.minutes(WORKSPACE_EXPORT_MAX_EVENT_AGE_MINUTES),
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      POWERTOOLS_SERVICE_NAME: WORKSPACE_EXPORT_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    logGroup: new logs.LogGroup(worker, 'ExportLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}
