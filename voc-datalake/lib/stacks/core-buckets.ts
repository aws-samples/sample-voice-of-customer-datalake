/**
 * VocCoreStack's three S3 buckets: access logs, the raw data lake, and the SPA
 * hosting bucket.
 *
 * Every bucket is versioned — the AWS S3 security best practice of being able to
 * recover from an accidental overwrite or delete
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
 * — and every bucket carries the lifecycle rules that keep versioning bounded:
 * noncurrent versions expire, abandoned multipart uploads are aborted, and
 * delete markers left behind are cleaned up, so versioning never turns into
 * unbounded storage growth. Same contract as the S3-import bucket
 * (ingestion-stack.ts `createS3ImportBucket`).
 *
 * The ONE exception is the raw data lake's append-only layers, `raw/` (bronze) and `silver/`
 * (Silver history) (TENETS.md D1): they keep history, so nothing under them ever expires,
 * current or noncurrent, and a bucket-policy statement refuses any PutObject under them that
 * could overwrite (no `If-None-Match`). Only voc-retention deletes there (lawful erasure / a declared retention period). The raw
 * bucket's workspace prefixes have no noncurrent rule either: a workspace delete removes every
 * version itself (RAW_BUCKET_WORKSPACE_PREFIXES); only `scratch/` expires, and, with the engineering agents on,
 * `engineering/cache/` (a rebuildable cache of repository code). The runs' objects are kept.
 *
 * Resources are created directly on the stack passed in (not inside a child
 * construct), so their logical ids are exactly those VocCoreStack always had.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { retainOnReplace } from '../utils/retain-on-replace';
import { dataProtection, type DataProtection } from '../utils/data-protection';

/**
 * Every prefix of the raw data bucket other than `raw/`: the workspace prefixes. None has a noncurrent-version
 * rule since 6.00 (wave C owner decision: a workspace artifact is really deleted when its owner deletes it, and the
 * deleting code removes every version itself, lib/utils/workspace-object-deletes.ts), so nothing here expires a
 * version behind the owner's back either. `scratch/` expires (SCRATCH_EXPIRATION_DAYS), and with the engineering
 * agents on, the caches under `engineering/cache/` (ENGINEERING_CACHE_EXPIRATION_DAYS). A new prefix must be
 * added here; `core-buckets.test.ts` checks every grant on the bucket in lib/stacks against this list.
 */
export const RAW_BUCKET_WORKSPACE_PREFIXES = [
  'avatars/', 'company-context/', 'engineering/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/',
] as const;
/** The bronze layer: written once (If-None-Match), never overwritten or expired. */
export const RAW_LAYER_PREFIX = 'raw/';
/**
 * Silver history: a feedback item as it was before each in-place change (lambda/shared/silver_provenance.py),
 * `silver/{source}/{feedback_id}/{stamp}-{sha8}.json`. Same contract as `raw/` (TENETS.md D1): written once
 * (If-None-Match), never overwritten, no lifecycle rule expires it; only voc-retention deletes it, with its item.
 */
export const SILVER_HISTORY_PREFIX = 'silver/';
/** The append-only layers of the raw data bucket: write-once, kept forever (only voc-retention deletes). */
export const APPEND_ONLY_PREFIXES = [RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX] as const;
/**
 * `scratch/` objects (workflow claim-checks) expire after this many days, and so do their noncurrent versions (a
 * workflow's own delete leaves one): no workflow runs longer than 2 h.
 */
export const SCRATCH_EXPIRATION_DAYS = 2;
/**
 * Only with `-c engineeringAgents=true` (docs/autonomous-engineering.md): the connections' caches,
 * `engineering/cache/`, a rebuildable copy of repository code, expire after ENGINEERING_CACHE_EXPIRATION_DAYS, their
 * noncurrent versions ENGINEERING_NONCURRENT_DAYS later. The runs' objects are in voc-eng-workspace and kept: they are
 * workspace artifacts, and an expiry of them waits for one that writes its `AUDIT#delete` row (TENETS.md D5; planned).
 */
export const ENGINEERING_CACHE_PREFIX = 'engineering/cache/';
export const ENGINEERING_CACHE_EXPIRATION_DAYS = 30;
const ENGINEERING_NONCURRENT_DAYS = 1;
/**
 * The engineering workspace bucket (only with `-c engineeringAgents=true`; lambda/engineering/workspace/layout.py):
 * `ws/<ws>/runs/<run>/<agent>/commits/…`, an agent's findings, gate records, logs and patches, and
 * `ws/<ws>/reports/<run>/…`, the commit, PR and goal reports. Nothing in it expires until an expiry that writes its
 * `AUDIT#delete` row exists (TENETS.md D5; planned). The one workspace (connectors/identity.py WORKSPACE, `default`,
 * until multi-workspace lands) is spelled out in every grant: an IAM wildcard crosses `/`, so a wildcard in place of
 * the workspace would let the reports' keys match a run object whose path holds `/reports/`.
 */
export const ENGINEERING_WORKSPACE = 'default';
export const ENGINEERING_WORKSPACE_REPORTS_KEYS = `ws/${ENGINEERING_WORKSPACE}/reports/*`;
export const ENGINEERING_WORKSPACE_RUNS_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*`;
/**
 * The quality gate's records (`…/_gate/attempt-<n>/record.json` under a final-go agent's keys), which the GO ledger
 * reads (lambda/engineering/flow/ledger.py): a retrospective, and the board for a flow's quality gate step.
 */
export const ENGINEERING_GATE_RECORD_KEYS = 'ws/*/runs/*/*/commits/*/_gate/attempt-*/record.json';
/**
 * The spend ledger's month partitions (`WS#<ws>#SPEND#<yyyy-mm>`, engineering/spend.py), as a `dynamodb:LeadingKeys`
 * pattern: the metering writers ADD to them in the same transaction as each priced session write.
 */
export const ENGINEERING_SPEND_PARTITIONS = `WS#${ENGINEERING_WORKSPACE}#SPEND#20??-??`;
/** The budget alerts' month partitions (lambda/engineering/spend.py alerts_pk): the supervisor's alone to write. */
export const ENGINEERING_BUDGET_ALERT_PARTITIONS = `WS#${ENGINEERING_WORKSPACE}#BUDGET#20??-??`;
/**
 * SPA bucket: each deploy's `s3 sync --delete` turns the previous build's assets
 * noncurrent. 30 days keeps a month of deploys restorable for a rollback; the
 * build itself is always reproducible from git, so longer buys nothing.
 */
export const WEBSITE_NONCURRENT_VERSION_DAYS = 30;
/**
 * Access logs are operational logs and keep 30 days like every other log (owner
 * decision 2026-11-01, lib/utils/log-retention.ts `LOG_RETENTION`): current objects
 * expire at 30 days, and a noncurrent version (an overwritten or deleted log object)
 * gets the same 30 days, one number for the whole bucket.
 */
export const ACCESS_LOGS_EXPIRATION_DAYS = 30;
export const ACCESS_LOGS_NONCURRENT_VERSION_DAYS = 30;
/** Abandoned multipart parts are billed until aborted (S3 cost best practice). */
export const ABORT_MULTIPART_DAYS = 7;

export interface CoreBucketNames {
  accessLogs: string;
  rawData: string;
  website: string;
}

export interface CoreBuckets {
  accessLogsBucket: s3.Bucket;
  rawDataBucket: s3.Bucket;
  websiteBucket: s3.Bucket;
}

/**
 * Noncurrent-version and multipart hygiene for a versioned bucket with no
 * current-version expiration, plus the separate rule S3 requires for
 * `ExpiredObjectDeleteMarker` (it is rejected alongside other expiration settings).
 */
function versionHygieneRules(noncurrentDays: number): s3.LifecycleRule[] {
  return [
    {
      id: 'version-hygiene',
      noncurrentVersionExpiration: cdk.Duration.days(noncurrentDays),
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(ABORT_MULTIPART_DAYS),
    },
    { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
  ];
}

/**
 * The raw data bucket's lifecycle: abandoned multipart uploads are aborted and expired delete markers removed
 * bucket-wide (neither removes data). No noncurrent-version rule anywhere: `raw/` keeps every version (TENETS.md
 * D1), nor `silver/`, and a workspace delete removes its own versions (RAW_BUCKET_WORKSPACE_PREFIXES). `scratch/` gets its own rule
 * where the bucket is created.
 */
function rawBucketVersionRules(): s3.LifecycleRule[] {
  return [
    { id: 'abort-incomplete-uploads', abortIncompleteMultipartUploadAfter: cdk.Duration.days(ABORT_MULTIPART_DAYS) },
    { id: 'remove-expired-delete-markers', expiredObjectDeleteMarker: true },
  ];
}

/**
 * Deny every PutObject / CompleteMultipartUpload under `raw/` and `silver/` (APPEND_ONLY_PREFIXES) that does
 * not send `If-None-Match`, so no writer (ours or out-of-band) can overwrite a bronze object or a kept Silver
 * version: a write either creates a new
 * key or gets 412. Multipart parts (CreateMultipartUpload, UploadPart, UploadPartCopy) cannot carry
 * the header and are exempted by `s3:ObjectCreationOperation`, as AWS documents
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html). A
 * consequence: CopyObject into `raw/` is impossible (403 without the header, 501 with it); nothing
 * copies into `raw/`.
 */
function denyOverwritingRawWrites(bucket: s3.Bucket): void {
  denyWritesWithoutIfNoneMatch(bucket, 'DenyRawWritesWithoutIfNoneMatch', APPEND_ONLY_PREFIXES.map((prefix) => `${prefix}*`));
}

/** The deny of denyOverwritingRawWrites, on `keys` of `bucket`, under `sid`. */
function denyWritesWithoutIfNoneMatch(bucket: s3.Bucket, sid: string, keys: readonly string[]): void {
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid,
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: keys.map((key) => bucket.arnForObjects(key)),
    conditions: {
      Null: { 's3:if-none-match': 'true' },
      Bool: { 's3:ObjectCreationOperation': 'true' },
    },
  }));
}

/** What differs between the private, versioned data buckets. */
export interface PrivateVersionedBucketOptions {
  readonly bucketName: string;
  readonly kmsKey: kms.IKey;
  readonly accessLogsBucket: s3.IBucket;
  readonly accessLogPrefix: string;
  readonly lifecycleRules?: s3.LifecycleRule[];
  readonly cors?: s3.CorsRule[];
  /**
   * Customer data (the raw bucket) follows `-c protectData`; a staging bucket omits it and
   * is always emptied and deleted with its stack.
   */
  readonly protection?: DataProtection;
}

/**
 * A KMS-encrypted, versioned data bucket: private, TLS-only and access-logged. By default it is
 * emptied (every object version and delete marker — the autoDeleteObjects provider lists versions)
 * then deleted with its stack; with data protection on (`-c protectData=true`) it is kept and has
 * no auto-delete provider. Back up first (docs/deployment.md).
 */
export function createPrivateVersionedBucket(
  scope: Construct, id: string, options: PrivateVersionedBucketOptions,
): s3.Bucket {
  const protection = options.protection ?? dataProtection(false);
  // Retained on REPLACEMENT (retainOnReplace). Without protectData the autoDeleteObjects provider
  // still empties the OLD bucket if its name changes, so the bucket names are pinned by
  // lib/test-support/baseline.json and a deployment prefix must never be changed on a live
  // deployment (docs/deployment.md, teardown).
  return retainOnReplace(new s3.Bucket(scope, id, {
    bucketName: options.bucketName,
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: options.kmsKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    removalPolicy: protection.removalPolicy,
    autoDeleteObjects: protection.autoDeleteObjects,
    serverAccessLogsBucket: options.accessLogsBucket,
    serverAccessLogsPrefix: options.accessLogPrefix,
    lifecycleRules: options.lifecycleRules,
    cors: options.cors,
  }));
}

/** The engineering caches' expiry rule (ENGINEERING_CACHE_EXPIRATION_DAYS); none without the engineering agents. */
function engineeringExpiryRules(engineeringAgents: boolean): s3.LifecycleRule[] {
  if (!engineeringAgents) return [];
  return [{
    id: 'engineering-cache-expiry', prefix: ENGINEERING_CACHE_PREFIX,
    expiration: cdk.Duration.days(ENGINEERING_CACHE_EXPIRATION_DAYS),
    noncurrentVersionExpiration: cdk.Duration.days(ENGINEERING_NONCURRENT_DAYS),
  }];
}

/**
 * The engineering agents' workspace (only with `-c engineeringAgents=true`): private, KMS-encrypted with the stack's
 * key, versioned, TLS-only and access-logged like the raw bucket, kept under `-c protectData` like customer data. Its
 * objects are written create-only (lambda/engineering/workspace/store.py, If-None-Match), and the bucket refuses
 * any other write, from any principal, as the raw bucket does under `raw/` (denyOverwritingRawWrites). Nothing
 * expires them (no current-version or noncurrent rule) until an expiry that writes its `AUDIT#delete` row exists;
 * only abandoned multipart uploads and expired delete markers are cleaned up, which removes no data.
 */
export function createEngineeringWorkspaceBucket(
  scope: Construct, bucketName: string, kmsKey: kms.IKey, accessLogsBucket: s3.IBucket, protection: DataProtection,
): s3.Bucket {
  const bucket = createPrivateVersionedBucket(scope, 'EngineeringWorkspaceBucket', {
    bucketName,
    kmsKey,
    accessLogsBucket,
    accessLogPrefix: 'engineering-workspace-bucket/',
    protection,
    lifecycleRules: rawBucketVersionRules(),
  });
  denyWritesWithoutIfNoneMatch(bucket, 'DenyWorkspaceWritesWithoutIfNoneMatch', ['*']);
  return bucket;
}

export function createCoreBuckets(
  scope: Construct,
  names: CoreBucketNames,
  kmsKey: kms.Key,
  corsAllowedOriginsBase: string[],
  protection: DataProtection,
  engineeringAgents = false,
): CoreBuckets {
  const accessLogsBucket = new s3.Bucket(scope, 'AccessLogsBucket', {
    bucketName: names.accessLogs,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    // Audit evidence: kept with the data under protectData (DATA-19), deleted with a demo's stacks otherwise.
    removalPolicy: protection.removalPolicy,
    autoDeleteObjects: protection.autoDeleteObjects,
    // ONE unprefixed rule (core-stack.test.ts pins why no prefix): current
    // versions expire at 30 days, which also lets S3 remove the resulting
    // expired delete markers itself, so no separate marker rule is needed
    // (https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).
    lifecycleRules: [{
      expiration: cdk.Duration.days(ACCESS_LOGS_EXPIRATION_DAYS),
      noncurrentVersionExpiration: cdk.Duration.days(ACCESS_LOGS_NONCURRENT_VERSION_DAYS),
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(ABORT_MULTIPART_DAYS),
    }],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
  });

  // Raw customer data is immutable and never deleted while the platform runs (only voc-retention
  // deletes under raw/); deleting the stack empties and deletes it unless protectData keeps it
  // (createPrivateVersionedBucket).
  const rawDataBucket = createPrivateVersionedBucket(scope, 'RawDataBucket', {
    bucketName: names.rawData,
    kmsKey,
    accessLogsBucket,
    accessLogPrefix: 'raw-data-bucket/',
    protection,
    lifecycleRules: [
      ...rawBucketVersionRules(),
      // Research / document workflow scratch copies of feedback-derived text (DATA-4): the workflows run at
      // most 2 h and delete their own on success; this removes what a failed or timed-out run left behind, and the
      // noncurrent version a workflow's own delete leaves (the bucket is versioned).
      {
        id: 'scratch-expiry', prefix: 'scratch/', expiration: cdk.Duration.days(SCRATCH_EXPIRATION_DAYS),
        noncurrentVersionExpiration: cdk.Duration.days(SCRATCH_EXPIRATION_DAYS),
      },
      // The engineering agents' repository caches (only with -c engineeringAgents=true); their runs' objects are in
      // voc-eng-workspace, where nothing expires.
      ...engineeringExpiryRules(engineeringAgents),
    ],
    cors: [{
      // PUT is required for browser-side presigned uploads (project product docs).
      // The CloudFront domain is not known at bucket-creation time (the frontend
      // distribution references this bucket in its behaviors, so using its domain
      // token here would create a circular dependency) — a *.cloudfront.net
      // wildcard is safe because presigned URLs remain the actual auth gate.
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
      allowedOrigins: [...corsAllowedOriginsBase, 'https://*.cloudfront.net'],
      allowedHeaders: ['*'],
      maxAge: 3600,
    }],
  });

  denyOverwritingRawWrites(rawDataBucket);

  // Frontend hosting bucket
  const websiteBucket = new s3.Bucket(scope, 'WebsiteBucket', {
    bucketName: names.website,
    encryption: s3.BucketEncryption.S3_MANAGED,
    publicReadAccess: false,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    serverAccessLogsBucket: accessLogsBucket,
    serverAccessLogsPrefix: 'website-bucket/',
    lifecycleRules: versionHygieneRules(WEBSITE_NONCURRENT_VERSION_DAYS),
  });

  return { accessLogsBucket, rawDataBucket, websiteBucket };
}
