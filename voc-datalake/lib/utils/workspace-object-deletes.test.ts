import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';

import { grantWorkspaceVersionDeletes } from './workspace-object-deletes';

function fixture(): { stack: cdk.Stack; bucket: s3.Bucket; role: iam.Role } {
  const stack = new cdk.Stack(new cdk.App(), 'S');
  return {
    stack,
    bucket: new s3.Bucket(stack, 'B', { versioned: true, enforceSSL: true }),
    role: new iam.Role(stack, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
  };
}

describe('grantWorkspaceVersionDeletes', () => {
  it.each([['raw/*'], ['raw/webscraper/*'], ['*']])('refuses the bronze layer or the whole bucket (%s)', (glob) => {
    const { bucket, role } = fixture();
    expect(() => grantWorkspaceVersionDeletes(bucket, role, [glob], 'X')).toThrow(/not a workspace prefix/);
  });

  it('refuses an empty prefix list', () => {
    const { bucket, role } = fixture();
    expect(() => grantWorkspaceVersionDeletes(bucket, role, [], 'X')).toThrow(/at least one prefix/);
  });

  it('grants the version delete on the objects and the listing on the bucket, pinned to the same prefixes', () => {
    const { stack, bucket, role } = fixture();
    grantWorkspaceVersionDeletes(bucket, role, ['avatars/*'], 'Avatars');
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([
        Match.objectLike({ Sid: 'AvatarsVersions', Effect: 'Allow', Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'] }),
        Match.objectLike({
          Sid: 'AvatarsListVersions', Effect: 'Allow', Action: 's3:ListBucketVersions',
          Condition: { StringLike: { 's3:prefix': ['avatars/*'] } },
        }),
      ]) },
    });
    expect(Object.keys(template.findResources('AWS::IAM::Policy'))).toHaveLength(1);
  });
});
