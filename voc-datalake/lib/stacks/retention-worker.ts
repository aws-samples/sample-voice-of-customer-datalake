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
 *   - feature requests: Scan / GetItem / Query / UpdateItem (an erasure by email de-identifies the person's board
 *     requests: REMOVE their email and name) and PutItem / DeleteItem pinned to `FR#*` (a +1's id derives from the
 *     email, so it is RE-KEYED: put under a new random id, the old row deleted, totals recomputed); their raw
 *     copies under `raw/feature_requests/` go with the raw grant above;
 *   - workspaces: Scan (an erasure by email finds the membership rows that hold the email: the table has no email
 *     index; a paged, time-budgeted Scan once per job, never on a request path, lambda/jobs/retention/members.py) and
 *     UpdateItem pinned to `WS#*` and to the attributes `email` and `name` (REMOVEd from a `MEMBER#` row; IAM cannot
 *     pin the sort key, so `META` is in reach of IAM and kept out by the code) — no Put, no Delete, no other
 *     attribute; the audit-row guard denies it any write of an `AUDIT#` row there;
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
import { grantKeyScopedWrites } from '../utils/table-write-grants';
import { grantInvokeByName, scheduleWorker, workerRole } from '../utils/worker-lambda';

/** The request partitions of voc-feature-requests (`FR#{id}`: META + its +1s), the only rows the worker re-keys. */
const FEATURE_REQUEST_PARTITIONS = 'FR#*';
/** The workspace partitions of voc-workspaces (`WS#{ws}`: META and the MEMBER# rows), the only rows it updates. */
const WORKSPACE_PARTITIONS = 'WS#*';
/** What an erasure by email removes from a membership row, and the key the update names. */
const MEMBER_PERSON_ATTRIBUTES = ['email', 'name', 'pk', 'sk'];

/** Path-style handler: the bundle keeps `jobs/retention/` with `shared/` beside `jobs/`. */
const RETENTION_HANDLER = 'jobs/retention/handler.lambda_handler';

/** The raw-archive prefix the worker may delete under (and list versions of). */
const RAW_PREFIX = 'raw/';
/** The kept Silver versions of an item (lambda/shared/silver_provenance.py): deleted with the item. */
const SILVER_PREFIX = 'silver/';

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
  /** voc-feature-requests: an erasure by email de-identifies the person's board requests and +1s. */
  featureRequestsTable: dynamodb.ITable;
  /** voc-workspaces: an erasure by email removes the email and name from the person's membership rows. */
  workspacesTable: dynamodb.ITable;
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

/** The worker; the caller wires its erasure-end notices (lib/utils/realtime.ts). */
export function createRetentionWorker(scope: Construct, id: string, props: RetentionWorkerProps): lambda.Function {
  // A plain construct with the same id keeps every logical id the class form had.
  const worker = new Construct(scope, id);
  const {
    uniqueName, kmsKey, feedbackTable, aggregatesTable, radarTable, projectsTable, featureRequestsTable, workspacesTable,
    rawDataBucket,
  } = props;
  const functionName = uniqueName(RETENTION_FUNCTION_BASE_NAME);

  const role = workerRole(worker, 'RetentionRole');
  feedbackTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem');
  aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query',
    'dynamodb:BatchGetItem');
  radarTable.grant(role, 'dynamodb:Scan', 'dynamodb:DeleteItem');
  grantCacheVersionBump(radarTable, role, RADAR_VERSION_PARTITION);
  projectsTable.grant(role, 'dynamodb:Scan', 'dynamodb:UpdateItem');
  // Boards: read + de-identify a request; RE-KEY an erased +1 (one transaction: Put the de-identified row under a new
  // random id, Delete the email-derived one), so Put/Delete are pinned to the request partitions (FR#*), never boards.
  featureRequestsTable.grant(role, 'dynamodb:Scan', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem');
  grantKeyScopedWrites(featureRequestsTable, role, ['PutItem', 'DeleteItem'], [FEATURE_REQUEST_PARTITIONS]);
  // Workspace memberships (lambda/jobs/retention/members.py): find the rows that hold the erased email (Scan: no
  // email index), then REMOVE email and name, on `WS#*` and those two attributes only.
  workspacesTable.grant(role, 'dynamodb:Scan');
  grantKeyScopedWrites(workspacesTable, role, ['UpdateItem'], [WORKSPACE_PARTITIONS], MEMBER_PERSON_ATTRIBUTES);
  kmsKey.grantEncryptDecrypt(role);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'DeleteRawArchiveObjects',
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: [rawDataBucket.arnForObjects(`${RAW_PREFIX}*`), rawDataBucket.arnForObjects(`${SILVER_PREFIX}*`)],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ListRawArchiveVersions',
    actions: ['s3:ListBucketVersions'],
    resources: [rawDataBucket.bucketArn],
    conditions: { StringLike: { 's3:prefix': [`${RAW_PREFIX}*`, `${SILVER_PREFIX}*`] } },
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
      FEATURE_REQUESTS_TABLE: featureRequestsTable.tableName,
      WORKSPACES_TABLE: workspacesTable.tableName,
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
  return fn;
}
