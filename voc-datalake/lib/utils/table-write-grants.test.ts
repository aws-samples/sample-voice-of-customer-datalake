/**
 * A write-only grant on a table encrypted with a customer-managed key must include kms:Decrypt: DynamoDB decrypts the
 * table key for the caller on a write too. Without it the ModelPin custom resource (one UpdateItem, write-only)
 * failed every fresh deployment with "not authorized to perform: kms:Decrypt"; existing deployments never re-ran it.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { grantKeyScopedWrites, grantReadAndWrites, grantWrites } from './table-write-grants';

const StatementSchema = z.object({ Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() });
const PolicySchema = z.object({ Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(StatementSchema) }) }) });

/** The actions the role's policy allows on the KMS key, after a grant made by `grant`. */
function keyActions(grant: (table: dynamodb.Table, role: iam.Role) => void): string[] {
  const stack = new cdk.Stack(new cdk.App(), 'Grants');
  const key = new kms.Key(stack, 'Key');
  const table = new dynamodb.Table(stack, 'Table', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
    encryptionKey: key,
  });
  const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  grant(table, role);
  const keyId = stack.resolve(key.keyArn);
  const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy')).map((p) => PolicySchema.parse(p));
  return policies
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((statement) => JSON.stringify(statement.Resource) === JSON.stringify(keyId))
    .flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]));
}

describe('table write grants on a customer-managed key', () => {
  it('grantWrites includes kms:Decrypt, so a write-only role can write', () => {
    expect(keyActions((table, role) => grantWrites(table, role, ['UpdateItem']))).toContain('kms:Decrypt');
  });

  it('grantKeyScopedWrites includes kms:Decrypt too', () => {
    expect(keyActions((table, role) => grantKeyScopedWrites(table, role, ['DeleteItem'], ['CIRCUIT#*']))).toContain('kms:Decrypt');
  });

  it('keeps the write key actions CDK grants for a write', () => {
    const actions = keyActions((table, role) => grantWrites(table, role, ['PutItem']));
    expect(actions).toStrictEqual(expect.arrayContaining(['kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*']));
  });

  it('grantReadAndWrites already had kms:Decrypt from its read half', () => {
    expect(keyActions((table, role) => grantReadAndWrites(table, role, ['UpdateItem']))).toContain('kms:Decrypt');
  });
});
