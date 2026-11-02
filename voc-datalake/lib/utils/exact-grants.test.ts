/**
 * lib/utils/exact-grants.ts: CDK grant wildcards become exact actions and per-index ARNs, cross-stack included,
 * with statement minimization still applied and a Deny left as it is.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cmkTableReadWriteKms, grantActions, GrantStatementSchema, kmsGrants, type GrantStatement } from '../test-support/exact-grant-statements';
import { byCodeUnit } from './compare';
import { applyExactGrants } from './exact-grants';

const env = { account: '111111111111', region: 'us-east-1' };

type Statement = GrantStatement;
const PoliciesSchema = z.record(z.string(), z.object({
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(GrantStatementSchema) }) }),
}));

function fixture() {
  const app = new cdk.App({ context: { '@aws-cdk/aws-iam:minimizePolicies': true } });
  const producer = new cdk.Stack(app, 'Producer', { env });
  const consumer = new cdk.Stack(app, 'Consumer', { env });
  const key = new kms.Key(producer, 'Key');
  const table = new dynamodb.Table(producer, 'Feedback', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED, encryptionKey: key,
  });
  table.addGlobalSecondaryIndex({ indexName: 'gsi1-by-date', partitionKey: { name: 'd', type: dynamodb.AttributeType.STRING } });
  table.addGlobalSecondaryIndex({ indexName: 'gsi2-by-category', partitionKey: { name: 'c', type: dynamodb.AttributeType.STRING } });
  table.addLocalSecondaryIndex({ indexName: 'lsi-by-score', sortKey: { name: 's', type: dynamodb.AttributeType.NUMBER } });
  const plain = new dynamodb.Table(producer, 'Plain', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
  const bucket = new s3.Bucket(producer, 'Raw', { encryptionKey: key, encryption: s3.BucketEncryption.KMS, enforceSSL: true, versioned: true });
  const fn = (scope: cdk.Stack, id: string) => new lambda.Function(scope, id, {
    runtime: lambda.Runtime.PYTHON_3_14, handler: 'h.handler', code: lambda.Code.fromInline('def handler(e, c): pass'),
  });
  return { app, producer, consumer, table, plain, bucket, fn };
}

function statements(stack: cdk.Stack, rolePrefix: string): Statement[] {
  const policies = PoliciesSchema.parse(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
  const match = Object.entries(policies).find(([id]) => id.startsWith(rolePrefix));
  if (match === undefined) throw new Error(`no policy ${rolePrefix}`);
  return match[1].Properties.PolicyDocument.Statement;
}

const actionsOf = grantActions;
const allActions = (list: readonly Statement[]) => list.flatMap(actionsOf);

describe('applyExactGrants', () => {
  it('a CMK-encrypted table read/write grant in another stack: exact KMS actions, one ARN per index', () => {
    const { app, consumer, table, plain, fn } = fixture();
    const job = fn(consumer, 'Job');
    table.grantReadWriteData(job);
    plain.grantReadData(job);
    applyExactGrants(app);
    const list = statements(consumer, 'JobServiceRoleDefaultPolicy');

    expect(kmsGrants(list)).toStrictEqual(cmkTableReadWriteKms('us-east-1'));
    const exportOf = (id: string) => ({ 'Fn::ImportValue': expect.stringMatching(new RegExp(`^Producer:ExportsOutputFnGetAtt${id}`)) });
    const indexArn = (name: string) => ({ 'Fn::Join': ['', [exportOf('Feedback'), `/index/${name}`]] });
    const dynamo = list.find((statement) => actionsOf(statement).includes('dynamodb:PutItem'));
    expect(dynamo?.Resource).toStrictEqual(expect.arrayContaining([
      exportOf('Feedback'), indexArn('gsi1-by-date'), indexArn('gsi2-by-category'), indexArn('lsi-by-score'),
    ]));
    expect(JSON.stringify(list)).not.toContain('/index/*');
    expect(allActions(list).filter((action) => action.includes('*'))).toStrictEqual([]);
  });

  it('a raw-bucket read grant: GetObject and ListBucket only, KMS Decrypt', () => {
    const { app, producer, bucket, fn } = fixture();
    bucket.grantRead(fn(producer, 'Reader'), 'raw/*');
    applyExactGrants(app);
    const list = statements(producer, 'ReaderServiceRoleDefaultPolicy');
    expect(list.map(actionsOf)).toStrictEqual([['s3:GetObject', 's3:ListBucket'], ['kms:Decrypt', 'kms:DescribeKey']]);
  });

  it('a write grant drops Abort*/GetBucket* and keeps DeleteObject; no DynamoDB means no ViaService extras', () => {
    const { app, producer, bucket, fn } = fixture();
    bucket.grantReadWrite(fn(producer, 'Writer'));
    applyExactGrants(app);
    const list = statements(producer, 'WriterServiceRoleDefaultPolicy');
    expect(allActions(list).sort(byCodeUnit)).toStrictEqual([
      'kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:GenerateDataKey', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket',
      's3:PutObject', 's3:PutObjectLegalHold', 's3:PutObjectRetention', 's3:PutObjectTagging', 's3:PutObjectVersionTagging',
    ]);
    expect(list.some((statement) => statement.Condition !== undefined)).toBe(false);
  });

  it('keeps a Deny wildcard and explicit delete actions as they are (the retention pattern)', () => {
    const { app, producer, bucket } = fixture();
    const role = new iam.Role(producer, 'Eraser', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'], resources: [bucket.arnForObjects('raw/*')],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY, actions: ['s3:DeleteObject*'], resources: [bucket.arnForObjects('raw/csv_upload/*')],
    }));
    applyExactGrants(app);
    const list = statements(producer, 'EraserDefaultPolicy');
    expect(list.map((statement) => [statement.Effect, actionsOf(statement)])).toStrictEqual([
      ['Allow', ['s3:DeleteObject', 's3:DeleteObjectVersion']], ['Deny', ['s3:DeleteObject*']],
    ]);
  });

  it('rewrites a statement added to an existing policy after the call, and is idempotent', () => {
    const { app, producer, table, bucket, fn } = fixture();
    const late = fn(producer, 'Late');
    bucket.grantRead(late);
    applyExactGrants(app);
    applyExactGrants(app);
    table.grantReadData(late);
    const list = statements(producer, 'LateServiceRoleDefaultPolicy');
    expect(JSON.stringify(list)).not.toContain('/index/*');
    expect(JSON.stringify(list)).toContain('/index/gsi1-by-date');
  });

  it('gives the CDK BucketDeployment handler what its own code calls', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env });
    const handler = new Construct(stack, 'Custom::CDKBucketDeployment1234');
    const role = new iam.Role(handler, 'ServiceRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['s3:Abort*', 's3:GetBucket*', 's3:List*'], resources: ['arn:aws:s3:::b'] }));
    applyExactGrants(app);
    expect(statements(stack, 'CustomCDKBucketDeployment1234ServiceRoleDefaultPolicy').map(actionsOf)).toStrictEqual([
      ['s3:AbortMultipartUpload', 's3:GetBucketLocation', 's3:GetBucketTagging', 's3:ListBucket'],
    ]);
  });

  it('leaves an index wildcard it cannot trace to a table', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S', { env });
    const role = new iam.Role(stack, 'Other', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const arn = 'arn:aws:dynamodb:us-east-1:111111111111:table/x/index/*';
    role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['dynamodb:Query'], resources: [arn] }));
    applyExactGrants(app);
    expect(statements(stack, 'OtherDefaultPolicy')).toStrictEqual([{ Effect: 'Allow', Action: 'dynamodb:Query', Resource: arn }]);
  });
});
