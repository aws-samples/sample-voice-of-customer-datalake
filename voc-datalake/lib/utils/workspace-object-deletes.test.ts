import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { IamPolicySchema, type IamStatement } from '../test-support/iam-statements';

import { grantWorkspaceObjects, grantWorkspaceVersionDeletes, VERSION_DELETE_ACTIONS } from './workspace-object-deletes';


/** A bucket (KMS-encrypted, like the raw data bucket) and a role. */
function fixture(): { stack: cdk.Stack; bucket: s3.Bucket; role: iam.Role } {
  const stack = new cdk.Stack(new cdk.App(), 'S');
  return {
    stack,
    bucket: new s3.Bucket(stack, 'B', { versioned: true, enforceSSL: true, encryption: s3.BucketEncryption.KMS }),
    role: new iam.Role(stack, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
  };
}

function statements(stack: cdk.Stack): IamStatement[] {
  return Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap((policy) => IamPolicySchema.parse(policy).Properties.PolicyDocument.Statement);
}

describe('grantWorkspaceVersionDeletes', () => {
  it.each([['raw/*'], ['raw/webscraper/*'], ['*'], ['exports/*']])('refuses anything but a workspace prefix (%s)', (glob) => {
    const { bucket, role } = fixture();
    expect(() => grantWorkspaceVersionDeletes(bucket, role, [glob])).toThrow(/not a workspace prefix/);
  });

  it('refuses an empty prefix list', () => {
    const { bucket, role } = fixture();
    expect(() => grantWorkspaceVersionDeletes(bucket, role, [])).toThrow(/at least one prefix/);
  });

  it('grants the version delete and the version listing in one statement, on the bucket and the prefix only', () => {
    const { stack, bucket, role } = fixture();
    grantWorkspaceVersionDeletes(bucket, role, ['avatars/*']);
    const [statement, ...rest] = statements(stack);
    expect(rest).toStrictEqual([]);
    expect(statement?.Action).toStrictEqual([...VERSION_DELETE_ACTIONS]);
    const resources = JSON.stringify(statement?.Resource);
    expect(resources).toContain('"/avatars/*"');
    expect(resources).not.toContain('"/*"');
  });

  it('grantWorkspaceObjects: read, write and every-version delete in one statement, plus the bucket key', () => {
    const { stack, bucket, role } = fixture();
    grantWorkspaceObjects(bucket, role, ['avatars/*', 'prototypes/*']);
    const s3Statements = statements(stack).filter((s) => [s.Action].flat().some((a) => a.startsWith('s3:')));
    expect(s3Statements).toHaveLength(1);
    expect([s3Statements[0]?.Action].flat()).toStrictEqual(
      ['s3:GetObject', 's3:ListBucket', 's3:PutObject', ...VERSION_DELETE_ACTIONS]);
    const resources = JSON.stringify(s3Statements[0]?.Resource);
    expect(['"/avatars/*"', '"/prototypes/*"'].filter((path) => !resources.includes(path))).toStrictEqual([]);
  });

  it('grantWorkspaceObjects refuses raw/ too', () => {
    const { bucket, role } = fixture();
    expect(() => grantWorkspaceObjects(bucket, role, ['avatars/*', 'raw/*'])).toThrow(/not a workspace prefix: raw\/\*/);
  });
});
