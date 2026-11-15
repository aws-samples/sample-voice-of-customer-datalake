/**
 * voc-engineering-cache, the checkout cache's writer (engineering-runtime.ts, only with `-c engineeringAgents=true`;
 * docs/autonomous-engineering.md, "The checkout cache"):
 *
 *   voc-engineering-runtime (a coordinator's launch, waited for) ──▶ voc-engineering-cache {connection, commit, generation}
 *
 * One immutable entry per (connection, commit, 14-day generation) in the raw bucket
 * (lambda/engineering/connectors/cache_layout.py): `engineering/cache/<connection>/<commit>/g<N>/repo.git/…`, then
 * `g<N>/READY`, create-only, last. A container-image Lambda
 * (voc-datalake/engineering-cache/Dockerfile: Lambda's Python base pinned by digest, the distro's git) built from
 * this repository by CDK as a Docker image asset for linux/arm64. It runs no repository code: git only fetches, with
 * an installation token for `contents: read` on the connection's one repository, handed to git by environment only.
 *
 * Its role holds exactly (beyond its own log group, lib/utils/lambda-log-grants.ts):
 * - `s3:PutObject` on the raw bucket's `engineering/cache/*` (the entries' files and READY; no other prefix, no
 *   ListBucket, no delete, no multipart: one PutObject per file), and `kms:GenerateDataKey` on the stack's key only
 *   through S3 and only for those keys (`kms:EncryptionContext:aws:s3:arn`);
 * - `s3:GetObject` on `engineering/cache/*\/*\/*\/READY` (its HeadObject: a fill that finds READY does nothing);
 * - the connections' credentials, read as the broker reads them (engineering-broker.ts grantConnectionCredentials);
 * - its claim rows in voc-engineering (`WS#<ws>#CACHE#<connection>`: GetItem, PutItem, UpdateItem, of a row only its
 *   claim's attributes, no ReturnValues), and the stack's key only through DynamoDB, for that table.
 * And it is the one writer the raw bucket lets put or delete under `engineering/cache/` (core-buckets.ts
 * denyCacheWritesButTheWriters: a bucket-policy Deny for every other principal, the role named by its fixed name).
 * Pay per use: no fixed cost (the image sits in the bootstrap's asset repository).
 */
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { LOG_RETENTION } from '../utils/log-retention';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { ENGINEERING_CACHE_PREFIX, engineeringCacheWriterRoleName } from './core-buckets';
import { type ConnectionParameters, grantConnectionCredentials } from './engineering-broker';

/** The function's own limit (seconds): the fill's steps fit inside it (lambda/engineering/connectors/cache.py). */
export const CACHE_TIMEOUT_SECONDS = 240;
/** Room for an entry of the cap (cache_layout.py MAX_ENTRY_BYTES, 1 GB) twice over (the fetched pack and its repack). */
const CACHE_EPHEMERAL_MIB = 3072;
/** The entries' keys, and their READY markers (`<connection>/<commit>/g<N>/READY`). */
const CACHE_ENTRY_KEYS = `${ENGINEERING_CACHE_PREFIX}*`;
export const CACHE_READY_KEYS = `${ENGINEERING_CACHE_PREFIX}*/*/*/READY`;
/** The claim rows' partitions (cache_layout.py CLAIM_PARTITION), a LeadingKeys pattern. */
const CLAIM_PARTITIONS = 'WS#*#CACHE#*';
/** A claim row's attributes, all the writer reads or writes (cache.py TableFillClaims; test_cache.py pins the row). */
const CLAIM_ATTRIBUTES = ['pk', 'sk', 'holder', 'expires_at'];
/** voc-datalake/: the image's build context, of which only what the Dockerfile copies is staged. */
const CONTEXT_DIR = path.join(__dirname, '../..');
const CONTEXT_EXCLUDES = [
  '*', '!engineering-cache/Dockerfile', '!engineering-cache/requirements.txt', '!lambda/engineering/**',
  '!lambda/shared/**',
  '**/test/**', '**/__pycache__/**', '**/*.pyc', '**/*.md',
];

export interface EngineeringCacheProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  kmsKey: kms.IKey;
  /** voc-engineering: the claim rows. */
  engineeringTable: dynamodb.ITable;
  /** The raw data lake: the entries under `engineering/cache/`. */
  rawDataBucket: s3.IBucket;
  /** The connections' credentials (the broker's): the token's source. */
  connectionParameters: ConnectionParameters;
}

/** The S3 statements: the entries written, READY read, the key through S3 for the entries only. */
function grantEntries(role: iam.Role, props: EngineeringCacheProps): void {
  const entries = props.rawDataBucket.arnForObjects(CACHE_ENTRY_KEYS);
  const ready = props.rawDataBucket.arnForObjects(CACHE_READY_KEYS);
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'CacheEntryWrites', actions: ['s3:PutObject'], resources: [entries] }));
  // READY create-only in IAM too: a put of it without If-None-Match is denied (S3's `s3:if-none-match` condition key,
  // the one the raw bucket's own policy uses for raw/; core-buckets.ts denyWritesWithoutIfNoneMatch).
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CacheReadyCreateOnly', effect: iam.Effect.DENY, actions: ['s3:PutObject'], resources: [ready],
    conditions: { Null: { 's3:if-none-match': 'true' } },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({ sid: 'CacheEntryReady', actions: ['s3:GetObject'], resources: [ready] }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CacheEntryKey',
    actions: ['kms:GenerateDataKey'],
    resources: [props.kmsKey.keyArn],
    conditions: {
      StringEquals: { 'kms:ViaService': `s3.${cdk.Stack.of(role).region}.amazonaws.com` },
      StringLike: { 'kms:EncryptionContext:aws:s3:arn': entries },
    },
  }));
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'The checkout cache\'s entries, one per connection and commit known only at run time: writes only under '
      + 'engineering/cache/ in the raw bucket, and reads only of the entries\' READY markers; no list, no delete',
    findings: [entries, ready].map(resourceFinding),
  }]);
}

/** The claim rows: a lease per (connection, commit), in their own partitions, of a row only the claim's attributes. */
function grantClaims(role: iam.Role, props: EngineeringCacheProps): void {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CacheClaims',
    actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
    resources: [props.engineeringTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [CLAIM_PARTITIONS] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': CLAIM_ATTRIBUTES },
      StringEqualsIfExists: { 'dynamodb:ReturnValues': 'NONE', 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
    },
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'CacheClaimsKey',
    actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
    resources: [props.kmsKey.keyArn],
    conditions: {
      StringEquals: {
        'kms:ViaService': `dynamodb.${cdk.Stack.of(role).region}.amazonaws.com`,
        'kms:EncryptionContext:aws:dynamodb:tableName': props.engineeringTable.tableName,
      },
    },
  }));
}

/** voc-engineering-cache and its role; the caller grants the invoke (the runtime's role, by name). */
export function createEngineeringCache(scope: Construct, props: EngineeringCacheProps): lambda.DockerImageFunction {
  // Its fixed name is the one the raw bucket's policy exempts from its deny of writes under engineering/cache/
  // (core-buckets.ts denyCacheWritesButTheWriters, in VocCoreStack, which cannot reference this stack).
  const role = new iam.Role(scope, 'EngineeringCacheRole', {
    roleName: engineeringCacheWriterRoleName(props.uniqueName),
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
  grantEntries(role, props);
  grantConnectionCredentials(role, props.kmsKey, props.connectionParameters.arns);
  grantClaims(role, props);
  const functionName = props.uniqueName('voc-engineering-cache');
  return new lambda.DockerImageFunction(scope, 'EngineeringCache', {
    functionName,
    code: lambda.DockerImageCode.fromImageAsset(CONTEXT_DIR, {
      file: 'engineering-cache/Dockerfile',
      platform: Platform.LINUX_ARM64,
      exclude: CONTEXT_EXCLUDES,
    }),
    architecture: lambda.Architecture.ARM_64,
    role,
    timeout: cdk.Duration.seconds(CACHE_TIMEOUT_SECONDS),
    // git's index-pack and repack of a pack up to the cap; Lambda's network share grows with memory too.
    memorySize: 2048,
    ephemeralStorageSize: cdk.Size.mebibytes(CACHE_EPHEMERAL_MIB),
    // Invoked and waited for by the runtime; a failure is answered to it, never retried here.
    retryAttempts: 0,
    environment: {
      RAW_DATA_BUCKET: props.rawDataBucket.bucketName,
      ENGINEERING_TABLE: props.engineeringTable.tableName,
      ENGINEERING_PARAMETER_PREFIX: props.connectionParameters.prefix,
      POWERTOOLS_SERVICE_NAME: 'voc-engineering-cache',
      LOG_LEVEL: 'INFO',
    },
    logGroup: new logs.LogGroup(scope, 'EngineeringCacheLogs', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: LOG_RETENTION,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
}
