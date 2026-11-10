/**
 * Dependency resources for stack-test fixtures, configured like the real ones.
 *
 * A fixture bucket or queue that is laxer than production (unversioned, HTTP
 * allowed, no public-access block, unencrypted) can hide a regression in the
 * stack under test — a grant or policy that only works because the dependency
 * is permissive — and is exactly what the S3/SQS security rules flag.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { REALTIME_NAMESPACES, type RealtimeNamespace, type RealtimePublishing } from '../utils/realtime';

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

/** The fixture Event API's HTTP host (what VocCoreStack's `RealtimeEventApi` answers as `httpDns`). */
export const FIXTURE_REALTIME_HTTP_DNS = 'fixture0000.appsync-api.us-east-1.amazonaws.com';

/**
 * VocCoreStack's realtime publishing (core-realtime.ts) on a deps stack: one managed policy per namespace, built
 * with the construct ids Core uses (`Realtime<Ns>PublishPolicy`), each `appsync:EventPublish` on exactly that
 * namespace of a fixture API, and the host.
 */
export function fixtureRealtime(scope: Construct): RealtimePublishing {
  const stack = cdk.Stack.of(scope);
  const policy = (key: RealtimeNamespace): iam.ManagedPolicy => new iam.ManagedPolicy(scope,
    `Realtime${key.charAt(0).toUpperCase()}${key.slice(1)}PublishPolicy`, {
      statements: [new iam.PolicyStatement({
        actions: ['appsync:EventPublish'],
        resources: [`arn:aws:appsync:${stack.region}:${stack.account}:apis/fixture0000/channelNamespace/${REALTIME_NAMESPACES[key]}`],
      })],
    });
  return { httpDns: FIXTURE_REALTIME_HTTP_DNS, publishPolicies: { jobs: policy('jobs'), chat: policy('chat'), runs: policy('runs') } };
}
