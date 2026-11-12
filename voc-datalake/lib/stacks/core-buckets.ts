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
 * (Silver history), and the same two in every tenant workspace, `ws/{ws}/raw/` and `ws/{ws}/silver/`
 * (TENETS.md D1): they keep history, so nothing under them ever expires,
 * current or noncurrent, and a bucket-policy statement refuses any PutObject under them that
 * could overwrite (no `If-None-Match`). Only voc-retention deletes there (lawful erasure / a declared retention period). The raw
 * bucket's workspace prefixes have no noncurrent rule either: a workspace delete removes every
 * version itself (RAW_BUCKET_WORKSPACE_PREFIXES); only `scratch/` expires.
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
 * version behind the owner's back either. `scratch/` alone expires (SCRATCH_EXPIRATION_DAYS). A new prefix must be
 * added here; `core-buckets.test.ts` checks every grant on the bucket in lib/stacks against this list.
 */
export const RAW_BUCKET_WORKSPACE_PREFIXES = [
  'avatars/', 'company-context/', 'memory-imports/', 'projects/', 'prototypes/', 'scratch/',
] as const;
/** The bronze layer: written once (If-None-Match), never overwritten or expired. */
export const RAW_LAYER_PREFIX = 'raw/';
/**
 * Silver history: a feedback item as it was before each in-place change (lambda/shared/silver_provenance.py),
 * `silver/{source}/{feedback_id}/{stamp}-{sha8}.json`. Same contract as `raw/` (TENETS.md D1): written once
 * (If-None-Match), never overwritten, no lifecycle rule expires it; only voc-retention deletes it, with its item.
 */
export const SILVER_HISTORY_PREFIX = 'silver/';
/**
 * The multi-workspace data path's root (docs/multi-workspace.md): every object of a tenant workspace is under
 * `ws/{ws}/` (lambda/shared/ws_repo.py `s3_key`). Not to be confused with RAW_BUCKET_WORKSPACE_PREFIXES, the
 * deployment's artifact prefixes ("workspace" there is the older word for a deployment's shared content).
 */
export const WORKSPACE_DATA_PREFIX = 'ws/';
/**
 * Exactly one workspace id in an IAM pattern (S3 resources, DynamoDB `LeadingKeys`): `ws_` and the ULID's 26
 * characters (lambda/shared/workspace_ids.py), one `?` each. Never `*`: IAM's `*` also matches `/` and `#`, so
 * `ws/*\/raw/*` would reach `ws/{ws}/silver/raw/…` and `WS#*#CIRCUIT#*` a source named `x#CIRCUIT#y`.
 */
export const WORKSPACE_ID_PATTERN = `ws_${'?'.repeat(26)}`;
/** A tenant workspace's bronze layer, `ws/{ws}/raw/` (the plugin ingestors since the ingestion slice): as `raw/`. */
export const WORKSPACE_RAW_LAYER_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/${RAW_LAYER_PREFIX}`;
/** A tenant workspace's Silver history, `ws/{ws}/silver/`: as `silver/` (no writer yet; the processor's slice). */
export const WORKSPACE_SILVER_HISTORY_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/${SILVER_HISTORY_PREFIX}`;
/**
 * The append-only layers of the raw data bucket: write-once, kept forever (only voc-retention deletes), at the
 * bucket's root and in every workspace (D1 holds per workspace too). IAM resource patterns, so
 * `WORKSPACE_ID_PATTERN` stands for one workspace id; a lifecycle rule cannot match them by prefix, and none may
 * cover `ws/` (core-buckets.test.ts).
 */
export const APPEND_ONLY_PREFIXES = [
  RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, WORKSPACE_RAW_LAYER_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX,
] as const;
/**
 * `scratch/` objects (workflow claim-checks) expire after this many days, and so do their noncurrent versions (a
 * workflow's own delete leaves one): no workflow runs longer than 2 h.
 */
export const SCRATCH_EXPIRATION_DAYS = 2;
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
 * Deny every PutObject / CompleteMultipartUpload under `raw/` and `silver/`, and under each workspace's
 * `ws/{ws}/raw/` and `ws/{ws}/silver/` (APPEND_ONLY_PREFIXES) that does not send `If-None-Match`, so no writer
 * (ours or out-of-band) can overwrite a bronze object or a kept Silver version: a write either creates a new
 * key or gets 412. Multipart parts (CreateMultipartUpload, UploadPart, UploadPartCopy) cannot carry
 * the header and are exempted by `s3:ObjectCreationOperation`, as AWS documents
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes-enforce.html). A
 * consequence: CopyObject into `raw/` is impossible (403 without the header, 501 with it); nothing
 * copies into `raw/`.
 */
function denyOverwritingRawWrites(bucket: s3.Bucket): void {
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyRawWritesWithoutIfNoneMatch',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    resources: APPEND_ONLY_PREFIXES.map((prefix) => bucket.arnForObjects(`${prefix}*`)),
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

export function createCoreBuckets(
  scope: Construct,
  names: CoreBucketNames,
  kmsKey: kms.Key,
  corsAllowedOriginsBase: string[],
  protection: DataProtection,
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
