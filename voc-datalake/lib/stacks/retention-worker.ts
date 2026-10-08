/**
 * The per-source retention / erasure worker, `voc-retention` (VocProcessingStack,
 * docs/source-policies.md). The ONE role in the app that may delete customer data,
 * and only in the two opt-in ways the handler (lambda/jobs/retention/handler.py)
 * implements:
 *
 *   - `{"mode": "retention"}`, daily: items of sources whose profile sets
 *     `retention_days`, older than the cutoff;
 *   - `{"mode": "erase", "job_id", "value"}`, async invoke by the settings API
 *     (POST /settings/erasure): items matching one field value.
 *
 * Each deleted item's `s3_raw_uri` object goes with it, every version. Least
 * privilege, pinned exactly by processing-stack-retention.test.ts:
 *   - feedback: GetItem / Query / Scan / DeleteItem — no Put, no Update;
 *   - raw bucket: DeleteObject + DeleteObjectVersion on `raw/*` and
 *     ListBucketVersions restricted to the `raw/` prefix — no read, no put —
 *     and an explicit Deny of `s3:DeleteObject*` on `raw/csv_upload/*` and
 *     `raw/json_upload/*` (whole-file archives are never deleted);
 *   - aggregates: GetItem / PutItem / UpdateItem / Query (source profiles, the
 *     erasure job row, the AUDIT#retention rows) — no delete;
 *   - lambda:InvokeFunction on its own unqualified name (time-budget hand-over).
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

import { RETENTION_FUNCTION_BASE_NAME } from '../utils/function-names';
import { PY_LAMBDA_ASSET_EXCLUDES, WORKER_TREE_ASSET_EXCLUDES } from '../utils/lambda-asset-excludes';
import { grantInvokeByName, scheduleWorker, workerRole } from '../utils/worker-lambda';

/** Path-style handler: the bundle keeps `jobs/retention/` with `shared/` beside `jobs/`. */
const RETENTION_HANDLER = 'jobs/retention/handler.lambda_handler';

/** The raw-archive prefix the worker may delete under (and list versions of). */
const RAW_PREFIX = 'raw/';
/** Whole-file upload archives (shared/retention.py `_WHOLE_UPLOAD_PREFIXES`): explicitly undeletable. */
const WHOLE_UPLOAD_PREFIXES = ['raw/csv_upload/', 'raw/json_upload/'] as const;

export interface RetentionWorkerProps {
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  feedbackTable: dynamodb.ITable;
  aggregatesTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
}

/**
 * Staged from `lambda/`, pruned to `jobs/retention`, `jobs/__init__.py` and
 * `shared/`, so no other job, API handler or worker tree moves this hash.
 */
function retentionCode(): lambda.Code {
  return lambda.Code.fromAsset('lambda', {
    exclude: [
      ...PY_LAMBDA_ASSET_EXCLUDES, ...WORKER_TREE_ASSET_EXCLUDES,
      '/aggregator/', '/api/', '/processor/', '/research/',
      '/jobs/*', '!/jobs/__init__.py', '!/jobs/retention/',
    ],
    ignoreMode: cdk.IgnoreMode.GIT,
    bundling: {
      image: lambda.Runtime.PYTHON_3_14.bundlingImage,
      command: [
        'bash', '-c',
        'mkdir -p /asset-output/jobs && cp /asset-input/jobs/__init__.py /asset-output/jobs/ && ' +
        'cp -r /asset-input/jobs/retention /asset-output/jobs/ && cp -r /asset-input/shared /asset-output/',
      ],
      platform: 'linux/arm64',
    },
  });
}

export class RetentionWorker extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: RetentionWorkerProps) {
    super(scope, id);
    const { uniqueName, kmsKey, feedbackTable, aggregatesTable, rawDataBucket } = props;
    const functionName = uniqueName(RETENTION_FUNCTION_BASE_NAME);

    const role = workerRole(this, 'RetentionRole');
    feedbackTable.grant(role, 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem');
    aggregatesTable.grant(role, 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query');
    kmsKey.grantEncryptDecrypt(role);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DeleteRawArchiveObjects',
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      resources: [rawDataBucket.arnForObjects(`${RAW_PREFIX}*`)],
    }));
    // Belt and braces over the matcher in shared/retention.py: the whole-upload
    // archives (many items in one object) are never deletable by this role,
    // whatever a bug in the per-item key check might ask for.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'NeverDeleteWholeUploadArchives',
      effect: iam.Effect.DENY,
      actions: ['s3:DeleteObject*'],
      resources: WHOLE_UPLOAD_PREFIXES.map((prefix) => rawDataBucket.arnForObjects(`${prefix}*`)),
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ListRawArchiveVersions',
      actions: ['s3:ListBucketVersions'],
      resources: [rawDataBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${RAW_PREFIX}*`] } },
    }));
    // Self hand-over before the 15-minute ceiling, by name (a GetAtt on the
    // function from its own role's policy would be a CloudFormation cycle).
    grantInvokeByName(cdk.Stack.of(this), role, [functionName], 'SelfInvoke');

    this.fn = new lambda.Function(this, 'Retention', {
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
        RETENTION_FUNCTION: functionName,
        POWERTOOLS_SERVICE_NAME: RETENTION_FUNCTION_BASE_NAME,
        LOG_LEVEL: 'INFO',
      },
      layers: [props.layer],
      logGroup: new logs.LogGroup(this, 'RetentionLogs', {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    scheduleWorker(this, 'RetentionSchedule', this.fn, uniqueName('voc-retention-schedule'),
      // 04:15 UTC — after the memory retention run (03:15), off the quarter-hour ticks.
      events.Schedule.cron({ hour: '4', minute: '15' }),
      events.RuleTargetInput.fromObject({ mode: 'retention' }));
  }
}
