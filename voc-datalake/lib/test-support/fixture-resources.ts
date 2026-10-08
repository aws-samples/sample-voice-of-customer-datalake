/**
 * Dependency resources for stack-test fixtures, configured like the real ones.
 *
 * A fixture bucket or queue that is laxer than production (unversioned, HTTP
 * allowed, no public-access block, unencrypted) can hide a regression in the
 * stack under test — a grant or policy that only works because the dependency
 * is permissive — and is exactly what the S3/SQS security rules flag.
 */
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/** A versioned, TLS-only, fully private bucket — the shape of every real VoC bucket. */
export function fixtureBucket(scope: Construct, id: string): s3.Bucket {
  return new s3.Bucket(scope, id, {
    versioned: true,
    enforceSSL: true,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
  });
}

/** A queue encrypted at rest, like the real processing queue. */
export function fixtureQueue(scope: Construct, id: string): sqs.Queue {
  return new sqs.Queue(scope, id, { encryption: sqs.QueueEncryption.SQS_MANAGED, enforceSSL: true });
}
