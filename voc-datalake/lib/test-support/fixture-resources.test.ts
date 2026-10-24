/**
 * Pins the fixture dependencies to the production shape, so a stack test can
 * never pass only because its bucket or queue is laxer than the real one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { fixtureBucket, fixtureQueue } from './fixture-resources';

describe('fixture resources', () => {
  let template: Template;

  beforeAll(() => {
    const stack = new cdk.Stack(new cdk.App(), 'Fixture');
    fixtureBucket(stack, 'Bucket');
    fixtureQueue(stack, 'Queue');
    template = Template.fromStack(stack);
  });

  it('builds a versioned bucket that blocks all public access', () => {
    expect(() => template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })).not.toThrow();
  });

  it('denies non-TLS access to the bucket', () => {
    expect(() => template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        })]),
      },
    })).not.toThrow();
  });

  it('builds a queue encrypted at rest', () => {
    expect(() => template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true })).not.toThrow();
  });
});
