/**
 * The per-source retention / erasure worker, `voc-retention` (VocProcessingStack,
 * docs/source-policies.md). The ONE role in the app that may delete customer data,
 * and only in the two opt-in ways the handler (lambda/jobs/retention/handler.py)
 * implements, each under a stated legal basis (TENETS.md D5):
 *
 *   - `{"mode": "retention"}`, daily: items of sources whose profile sets
 *     `retention_days`, older than the cutoff;
 *   - `{"mode": "erase", "job_id", "value"}`, async invoke by the settings API
 *     (POST /settings/erasure): items matching one field value; with the job's
 *     `field: 'source'`, every item of one source and then everything left under
 *     `raw/<source>/` (the grants below already cover it).
 *
 * Each deleted item gets a tombstone first; its `s3_raw_uri` object goes with it,
 * every version; Radar reviews go the same way; artifacts in voc-projects that
 * cited a deleted item are marked. Least privilege, pinned exactly by
 * processing-stack-retention.test.ts:
 *   - feedback: GetItem / Query / Scan / DeleteItem — no Put, no Update;
 *   - raw bucket: DeleteObject + DeleteObjectVersion on `raw/*` and
 *     ListBucketVersions restricted to the `raw/` prefix — no read, no put. The
 *     whole-file uploads (`raw/csv_upload/`, `raw/json_upload/`) are under it: a
 *     whole-source erasure deletes the source's own uploaded files (every row of one
 *     is filed under the one source its upload named, shared/retention.py);
 *   - aggregates: GetItem / PutItem / UpdateItem / Query (source profiles, the
 *     erasure job row, the AUDIT#retention rows, one PutItem per tombstone: no BatchWriteItem, which
 *     would also allow deletes) and BatchGetItem (the lineage pass's tombstone lookups) — no delete;
 *   - radar: Scan / DeleteItem (a review and its dedupe marker) and the cache-version
 *     bump (UpdateItem on `SETTINGS#radar` only) — no Put, no Query;
 *   - projects: Scan / UpdateItem (mark artifacts, drop erased ids) — no delete, no put;
 *   - lambda:InvokeFunction on its own unqualified name (time-budget hand-over).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from '../utils/log-retention';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { grantCacheVersionBump, RADAR_VERSION_PARTITION } from '../utils/cache-version-grants';
import { RETENTION_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { pythonLambdaAsset } from '../utils/python-lambda-asset';
import { grantInvokeByName, scheduleWorker, workerRole } from '../utils/worker-lambda';

/** Path-style handler: the bundle keeps `jobs/retention/` with `shared/` beside `jobs/`. */
const RETENTION_HANDLER = 'jobs/retention/handler.lambda_handler';

/** The raw-archive prefix the worker may delete under (and list versions of). */
const RAW_PREFIX = 'raw/';

export interface RetentionWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  /** voc-radar: other brands' reviews, erased like our own (docs/radar.md). */
  radarTable: dynamodb.ITable;
  /** voc-projects: artifacts whose lineage names an erased item are marked. */
  projectsTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
}

/**
 * Staged from `lambda/`, pruned to `jobs/retention`, `jobs/__init__.py` and
 * `shared/`, so no other job, API handler or worker tree moves this hash.
 */
function retentionCode(): lambda.Code {
  return pythonLambdaAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/aggregator/', '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/retention/',
    ],
    copy: [
      'mkdir -p /asset-output/jobs',
      'cp /asset-input/jobs/__init__.py /asset-output/jobs/',
      'cp -r /asset-input/jobs/retention /asset-output/jobs/',
      'cp -r /asset-input/shared /asset-output/',
    ],
  });
}

export function createRetentionWorker(scope: Construct, id: string, props: RetentionWorkerProps): void {
  // A plain construct with the same id keeps every logical id the class form had.
  const worker = new Construct(scope, id);
  const { uniqueName, kmsKey, feedbackTable, aggregatesTable, radarTable, projectsTable, rawDataBucket } = props;
  const functionName = uniqueName(RETENTION_FUNCTION_BASE_NAME);

  const role = workerRole(worker, 'RetentionRole');
  feedbackTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem');
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query',
    'dynamodb:BatchGetItem');
  radarTable.grant(role, 'dynamodb:Scan', 'dynamodb:DeleteItem');
  grantCacheVersionBump(radarTable, role, RADAR_VERSION_PARTITION);
  projectsTable.grant(role, 'dynamodb:Scan', 'dynamodb:UpdateItem');
  kmsKey.grantEncryptDecrypt(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DeleteRawArchiveObjects',
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: [rawDataBucket.arnForObjects(`${RAW_PREFIX}*`)],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ListRawArchiveVersions',
    actions: ['s3:ListBucketVersions'],
    resources: [rawDataBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [`${RAW_PREFIX}*`] } },
  }));
  // Self hand-over before the 15-minute ceiling, by name (a GetAtt on the
  // function from its own role's policy would be a CloudFormation cycle).
  grantInvokeByName(cdk.Stack.of(worker), role, [functionName], 'SelfInvoke');

  const fn = new lambda.Function(worker, 'Retention', {
    functionName,
    runtime: lambda.Runtime.PYTHON_3_14,
    architecture: lambda.Architecture.ARM_64,
    handler: RETENTION_HANDLER,
    code: retentionCode(),
    role,
    timeout: cdk.Duration.minutes(15),
    memorySize: 512,
    // A hidden re-drive would race the job row's checkpoint; the job/audit
    // rows record failures, and the next daily tick catches up.
    retryAttempts: 0,
    environment: {
      FEEDBACK_TABLE: feedbackTable.tableName,
      AGGREGATES_TABLE: aggregatesTable.tableName,
      RAW_DATA_BUCKET: rawDataBucket.bucketName,
      RADAR_TABLE: radarTable.tableName,
      PROJECTS_TABLE: projectsTable.tableName,
      // No RETENTION_FUNCTION: the worker re-invokes itself via context.function_name.
      POWERTOOLS_SERVICE_NAME: RETENTION_FUNCTION_BASE_NAME,
      LOG_LEVEL: 'INFO',
    },
    layers: [props.layer],
    logGroup: new logs.LogGroup(worker, 'RetentionLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  scheduleWorker(worker, 'RetentionSchedule', fn, uniqueName('voc-retention-schedule'),
    // 04:15 UTC — after the memory retention run (03:15), off the quarter-hour ticks.
    events.Schedule.cron({ hour: '4', minute: '15' }),
    events.RuleTargetInput.fromObject({ mode: 'retention' }));
}
