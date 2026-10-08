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
 * Resources are created directly on the stack passed in (not inside a child
 * construct), so their logical ids are exactly those VocCoreStack always had.
 */
import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * Raw data lake: noncurrent versions are recoverable for 90 days. Raw records
 * are written once and never overwritten, so a noncurrent version only exists
 * after a mistake (or a regenerated avatar/prototype/document); a quarter is
 * long enough to notice and restore customer data before it is purged.
 */
export const RAW_NONCURRENT_VERSION_DAYS = 90;
/**
 * SPA bucket: each deploy's `s3 sync --delete` turns the previous build's assets
 * noncurrent. 30 days keeps a month of deploys restorable for a rollback; the
 * build itself is always reproducible from git, so longer buys nothing.
 */
export const WEBSITE_NONCURRENT_VERSION_DAYS = 30;
/**
 * Access logs already expire at 90 days; a noncurrent version (an overwritten or
 * deleted log object) only needs a week's grace for investigation.
 */
export const ACCESS_LOGS_NONCURRENT_VERSION_DAYS = 7;
const ACCESS_LOGS_EXPIRATION_DAYS = 90;
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

export function createCoreBuckets(
  scope: Construct,
  names: CoreBucketNames,
  kmsKey: kms.Key,
  corsAllowedOriginsBase: string[],
): CoreBuckets {
  const accessLogsBucket = new s3.Bucket(scope, 'AccessLogsBucket', {
    bucketName: names.accessLogs,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    // ONE unprefixed rule (core-stack.test.ts pins why no prefix): current
    // versions expire at 90 days, which also lets S3 remove the resulting
    // expired delete markers itself, so no separate marker rule is needed
    // (https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html).
    lifecycleRules: [{
      expiration: cdk.Duration.days(ACCESS_LOGS_EXPIRATION_DAYS),
      noncurrentVersionExpiration: cdk.Duration.days(ACCESS_LOGS_NONCURRENT_VERSION_DAYS),
      abortIncompleteMultipartUploadAfter: cdk.Duration.days(ABORT_MULTIPART_DAYS),
    }],
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
  });

  const rawDataBucket = new s3.Bucket(scope, 'RawDataBucket', {
    bucketName: names.rawData,
    encryption: s3.BucketEncryption.KMS,
    encryptionKey: kmsKey,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    versioned: true,
    // Raw customer data is immutable and kept forever: RETAIN, and no
    // autoDeleteObjects custom resource that would empty it on destroy.
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    serverAccessLogsBucket: accessLogsBucket,
    serverAccessLogsPrefix: 'raw-data-bucket/',
    lifecycleRules: versionHygieneRules(RAW_NONCURRENT_VERSION_DAYS),
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
