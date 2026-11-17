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
 * could overwrite (no `If-None-Match`). Only voc-retention deletes there (lawful erasure / a declared retention period),
 * and, under one workspace's `ws/{ws}/` only, voc-workspace-delete (that workspace's hard delete, decision 17). The raw
 * bucket's workspace prefixes have no noncurrent rule either: a workspace delete removes every
 * version itself (RAW_BUCKET_WORKSPACE_PREFIXES); only `scratch/` expires, a workspace export's objects
 * (`ws/{ws}/exports/`), by their `voc-export=true` tag, which the bucket policy refuses anywhere else, and, with the
 * engineering agents on, `engineering/cache/` (a rebuildable cache of repository code). The runs' objects are kept.
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
 * (If-None-Match), never overwritten, no lifecycle rule expires it; only voc-retention deletes it, with its item (and,
 * under a deleted workspace's `ws/{ws}/`, voc-workspace-delete).
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
/**
 * A tenant workspace's page imports, `ws/{ws}/memory-imports/` (the memory API puts the original page, the extractor
 * reads it: lambda/shared/memory_store.py `import_object_key`): as `memory-imports/`.
 */
export const WORKSPACE_MEMORY_IMPORTS_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/memory-imports/`;
/** A tenant workspace's Silver history, `ws/{ws}/silver/`: as `silver/` (the processor writes it for a workspace's messages, 7.00.00). */
export const WORKSPACE_SILVER_HISTORY_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/${SILVER_HISTORY_PREFIX}`;
/**
 * The append-only layers of the raw data bucket: write-once, kept forever (only voc-retention deletes, and
 * voc-workspace-delete a deleted workspace's whole `ws/{ws}/`), at the
 * bucket's root and in every workspace (D1 holds per workspace too). IAM resource patterns, so
 * `WORKSPACE_ID_PATTERN` stands for one workspace id; a lifecycle rule cannot match them by prefix, and none may
 * cover `ws/` (core-buckets.test.ts).
 */
export const APPEND_ONLY_PREFIXES = [
  RAW_LAYER_PREFIX, SILVER_HISTORY_PREFIX, WORKSPACE_RAW_LAYER_PREFIX, WORKSPACE_SILVER_HISTORY_PREFIX,
] as const;
/**
 * A tenant workspace's exports, `ws/{ws}/exports/` (docs/multi-workspace.md "Export and delete", the export job
 * lib/stacks/api-workspace-export.ts): a copy of the workspace's data for its admins to download, not a tier of the
 * lake, so it expires (EXPORT_EXPIRATION_DAYS).
 */
export const WORKSPACE_EXPORTS_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/exports/`;
/**
 * Every object of one workspace, `ws/{one id}/*`: what its export reads into its zip (slice 4b, the listing's
 * `s3:prefix` and its GetObject; lib/stacks/workspace-export-worker.ts).
 */
export const WORKSPACE_OBJECTS_PREFIX = `${WORKSPACE_DATA_PREFIX}${WORKSPACE_ID_PATTERN}/*`;
/**
 * The object tag every export object carries (`voc-export=true`, lambda/shared/ws_repo.py `EXPORT_TAGGING`), and
 * the one thing the export lifecycle rule matches: a lifecycle prefix cannot name "every workspace's exports/"
 * (it is literal), so the rule filters on the tag, and the bucket policy refuses the tag on any key outside a
 * workspace's exports (DenyExportTagOutsideExports), so it can never expire anything in raw/ or silver/ (D1).
 */
export const EXPORT_TAG_KEY = 'voc-export';
const EXPORT_TAG_VALUE = 'true';
/**
 * An export's objects expire 10 days after they are written: its download window is 7 days (the server's,
 * lambda/shared/export_jobs.py), plus a margin; the version the expiry leaves behind goes 1 day later.
 */
export const EXPORT_EXPIRATION_DAYS = 10;
export const EXPORT_NONCURRENT_VERSION_DAYS = 1;
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
/**
 * The checkout cache writer's role name (engineering-cache.ts), before the stack's `uniqueName`: fixed, so the raw
 * bucket's policy (in this stack) names the writer by ARN without a reference to VocProcessingStack.
 */
export const ENGINEERING_CACHE_WRITER_ROLE_BASE_NAME = 'voc-engineering-cache';

/** The checkout cache writer's role name, by the owning stack's prefix-aware `uniqueName` (the one source of it). */
export function engineeringCacheWriterRoleName(uniqueName: (baseName: string) => string): string {
  return uniqueName(ENGINEERING_CACHE_WRITER_ROLE_BASE_NAME);
}

/** That role's ARN, in `scope`'s stack (VocCoreStack's bucket policy names it so, with no cross-stack reference). */
export function engineeringCacheWriterRoleArn(scope: Construct, uniqueName: (baseName: string) => string): string {
  return cdk.Arn.format({ service: 'iam', region: '', resource: 'role',
    resourceName: engineeringCacheWriterRoleName(uniqueName) }, cdk.Stack.of(scope));
}
/** The object writes and deletes the raw bucket refuses under ENGINEERING_CACHE_PREFIX to all but the writer. */
const ENGINEERING_CACHE_DENIED_ACTIONS =['s3:PutObject*', 's3:DeleteObject*'] as const;
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
 * The readiness probe's key (7.50.00, lambda/engineering/readiness_aws.py PROBE_KEY): the Agents API's one create-only
 * object in the workspace bucket, beside (never inside) the runs' keys.
 */
export const ENGINEERING_WORKSPACE_READINESS_KEYS = `ws/${ENGINEERING_WORKSPACE}/_readiness/*`;
/**
 * The quality gate's records (`…/_gate/attempt-<n>/record.json` under a final-go agent's keys), which the GO ledger
 * reads (lambda/engineering/flow/ledger.py): a retrospective, and the board for a flow's quality gate step.
 */
export const ENGINEERING_GATE_RECORD_KEYS = 'ws/*/runs/*/*/commits/*/_gate/attempt-*/record.json';
/**
 * 7.51.00, the run workspace: the agents' working trees as patches (their checkpoints' and their submitted ones),
 * a child run's seeds (lambda/engineering/runtime/harness/seed.py: under the child's own `_seed/`, beside its agents'
 * keys), the agents' findings and notes (one `.jsonl` per shard and attempt, workspace/layout.py), an understander's
 * triage, and the transcripts and checkpoints no reader of outputs is let near.
 */
export const ENGINEERING_PATCH_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/_patches/*`;
export const ENGINEERING_SEED_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/_seed/*`;
export const ENGINEERING_FINDING_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/*/attempt-*/*.jsonl`;
export const ENGINEERING_TRIAGE_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/_triage/*`;
export const ENGINEERING_TRANSCRIPT_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/_transcripts/*`;
export const ENGINEERING_CHECKPOINT_KEYS = `ws/${ENGINEERING_WORKSPACE}/runs/*/*/commits/*/_checkpoints/*`;
/** The runs list's month partitions (7.51.00, lambda/engineering/runtime/runs.py runlist_key). */
export const ENGINEERING_RUNLIST_PARTITIONS = `WS#${ENGINEERING_WORKSPACE}#RUNLIST#20??-??`;
/**
 * The knowledge packs' objects (lambda/engineering/knowledge/store.py: `ws/<ws>/knowledge/<connection>/<package>/v<n>/`),
 * written once by the packs' publish: the board reads them for an agent, and since 7.52.00 the Agents API (an approval's
 * rendering, a preview) and the broker (the docs it writes, rendered again).
 */
export const ENGINEERING_WORKSPACE_KNOWLEDGE_KEYS = `ws/${ENGINEERING_WORKSPACE}/knowledge/*`;
/**
 * The repositories' partitions in voc-engineering (`WS#<ws>#REPO#<connection>`, 7.52.00 knowledge/store.py, tenets.py,
 * docs.py): the knowledge packs' versions and their rendering, the tenets' versions, as a `dynamodb:LeadingKeys` pattern.
 */
export const ENGINEERING_REPO_PARTITIONS = 'WS#*#REPO#*';
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

/**
 * Deny every PutObject or PutObjectTagging that sets the export tag (EXPORT_TAG_KEY) on a key outside a workspace's
 * exports (WORKSPACE_EXPORTS_PREFIX, one workspace id: never `ws/*\/exports/*`, whose `*` would also match
 * `ws/{ws}/raw/exports/…`), for every principal: the export lifecycle rule matches that tag alone, so this keeps it
 * from ever reaching `raw/`, `silver/` or any other prefix (D1: nothing there expires).
 */
function denyExportTagOutsideExports(bucket: s3.Bucket): void {
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyExportTagOutsideExports',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject', 's3:PutObjectTagging'],
    notResources: [bucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`)],
    conditions: { 'ForAnyValue:StringEquals': { 's3:RequestObjectTagKeys': EXPORT_TAG_KEY } },
  }));
  // A copy keeps its source's tags unless the request replaces them, and then names no tag key at all: so no object
  // under any workspace's exports may be copied to a key outside one (it would carry the tag out).
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyExportCopiesOutsideExports',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ['s3:PutObject'],
    notResources: [bucket.arnForObjects(`${WORKSPACE_EXPORTS_PREFIX}*`)],
    conditions: { StringLike: { 's3:x-amz-copy-source': EXPORT_COPY_SOURCES } },
  }));
}

/**
 * A copy source (`bucket/key`, with or without a leading `/`, its `/` sent as is or URL-encoded `%2F` / `%2f`)
 * naming one workspace's exports: the workspace segment is one id (`WORKSPACE_ID_PATTERN`), as everywhere.
 */
const EXPORT_COPY_SOURCES = [
  `*ws/${WORKSPACE_ID_PATTERN}/exports/*`,
  `*ws%2F${WORKSPACE_ID_PATTERN}%2Fexports%2F*`,
  `*ws%2f${WORKSPACE_ID_PATTERN}%2fexports%2f*`,
];

/** The raw bucket's one expiring rule outside scratch/: a workspace export's objects, by their tag. */
function exportExpiryRule(): s3.LifecycleRule {
  return {
    id: 'export-expiry',
    tagFilters: { [EXPORT_TAG_KEY]: EXPORT_TAG_VALUE },
    expiration: cdk.Duration.days(EXPORT_EXPIRATION_DAYS),
    noncurrentVersionExpiration: cdk.Duration.days(EXPORT_NONCURRENT_VERSION_DAYS),
  };
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

/**
 * Only the checkout cache's writer writes or deletes under `engineering/cache/` (docs/autonomous-engineering.md, "The
 * checkout cache"): an entry stands for a repository's code at a commit, so a READY or a pack put there by anyone else
 * (an admin's Data Explorer, which may put anywhere else in the bucket) would be cloned by the agents, or block the
 * commit's fill for up to its 14-day generation. A Deny for every principal whose `aws:PrincipalArn` is not the
 * writer's role (by its fixed name: no reference to VocProcessingStack) of ENGINEERING_CACHE_DENIED_ACTIONS on those
 * keys. Exempt as well, only when this bucket auto-deletes (without protectData): the stack's auto-delete provider,
 * which empties it with the stack. The lifecycle expiry is S3's own and no principal's, so the deny never touches it.
 */
function denyCacheWritesButTheWriters(bucket: s3.Bucket, writerRoleArn: string, autoDeletes: boolean): void {
  const exempt = [writerRoleArn];
  if (autoDeletes) {
    const provider = cdk.Stack.of(bucket).node.tryFindChild(AUTO_DELETE_PROVIDER_ID);
    if (!(provider instanceof cdk.CustomResourceProviderBase)) throw new Error('the raw bucket\'s auto-delete provider is missing');
    exempt.push(provider.roleArn);
  }
  bucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'DenyEngineeringCacheWritesButTheWriters',
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: [...ENGINEERING_CACHE_DENIED_ACTIONS],
    resources: [bucket.arnForObjects(`${ENGINEERING_CACHE_PREFIX}*`)],
    conditions: { ArnNotEquals: { 'aws:PrincipalArn': exempt } },
  }));
}

/** The construct id CDK gives the stack's one S3 auto-delete provider (aws-s3 Bucket `autoDeleteObjects`). */
const AUTO_DELETE_PROVIDER_ID = 'Custom::S3AutoDeleteObjectsCustomResourceProvider';

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
  /** The checkout cache writer's role ARN; given only with `-c engineeringAgents=true`. */
  engineeringCacheWriterRoleArn?: string,
): CoreBuckets {
  const engineeringAgents = engineeringCacheWriterRoleArn !== undefined;
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
  // deletes under raw/, and voc-workspace-delete every version under one deleted workspace's ws/{ws}/);
  // deleting the stack empties and deletes it unless protectData keeps it (createPrivateVersionedBucket).
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
      exportExpiryRule(),
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
  denyExportTagOutsideExports(rawDataBucket);
  if (engineeringCacheWriterRoleArn !== undefined) {
    denyCacheWritesButTheWriters(rawDataBucket, engineeringCacheWriterRoleArn, protection.autoDeleteObjects);
  }

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
