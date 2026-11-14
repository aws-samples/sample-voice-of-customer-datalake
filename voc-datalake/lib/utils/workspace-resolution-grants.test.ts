/**
 * The two reads of a writer's workspace status check (lib/utils/workspace-resolution-grants.ts), pinned side by side:
 * `grantWorkspaceStatusRead` (the ingestors, the feedback processor, the aggregator, the webhooks, voc-retention) and
 * `grantWorkspaceRoleAndStatusReads` (the assistant's stream Lambda, since 7.25.00). One statement builder makes both:
 * they differ in their attribute list alone, and each list is the code's own projection.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { itemAt } from '../test-support/guards';
import { IamPolicySchema, statementActions, WORKSPACE_STATUS_READ_CONDITION } from '../test-support/iam-statements';
import { byCodeUnit } from './compare';
import { grantWorkspaceRoleAndStatusReads, grantWorkspaceStatusRead } from './workspace-resolution-grants';

const ConditionSchema = z.object({
  'ForAllValues:StringLike': z.object({ 'dynamodb:LeadingKeys': z.array(z.string()) }),
  'ForAllValues:StringEquals': z.object({ 'dynamodb:Attributes': z.array(z.string()) }),
  StringEqualsIfExists: z.object({ 'dynamodb:Select': z.string() }),
  Null: z.object({ 'dynamodb:Attributes': z.string() }),
});

/** Every statement the role's policy holds after `grant`, with its actions and its condition. */
function statementsAfter(grant: (role: iam.Role, table: dynamodb.Table) => void) {
  const stack = new cdk.Stack(new cdk.App(), 'Grants');
  const table = new dynamodb.Table(stack, 'Workspaces', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  const role = new iam.Role(stack, 'Role', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
  grant(role, table);
  return Object.values(Template.fromStack(stack).findResources('AWS::IAM::Policy'))
    .flatMap((resource) => IamPolicySchema.parse(resource).Properties.PolicyDocument.Statement)
    .map((statement) => ({ actions: statementActions(statement), condition: ConditionSchema.parse(statement.Condition) }));
}

/** The string list `name = [ ... ] as const` in a stream Lambda source (its projection of a voc-workspaces read). */
function streamList(file: string, name: string): string[] {
  const source = readFileSync(join(__dirname, '..', '..', 'lambda', 'stream', 'src', 'assistant', 'session', file), 'utf8');
  const listed = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(source)?.[1];
  if (listed === undefined) throw new Error(`${name} not found in ${file}`);
  return [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('a writer\'s workspace status reads', () => {
  const status = statementsAfter((role, table) => grantWorkspaceStatusRead(role, table));
  let env: Record<string, string> = {};
  const roleAndStatus = statementsAfter((role, table) => { env = grantWorkspaceRoleAndStatusReads(table, role); });

  it('grantWorkspaceStatusRead: one GetItem of WS#* rows, pk, sk and status only, a projection required', () => {
    expect(status).toStrictEqual([{ actions: ['dynamodb:GetItem'], condition: WORKSPACE_STATUS_READ_CONDITION }]);
  });

  it('grantWorkspaceRoleAndStatusReads: the same statement with a member row\'s role besides, and the table\'s name', () => {
    expect(roleAndStatus).toStrictEqual([{ actions: ['dynamodb:GetItem'], condition: {
      ...WORKSPACE_STATUS_READ_CONDITION,
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'role', 'status'] },
    } }]);
    expect(Object.keys(env)).toStrictEqual(['WORKSPACES_TABLE']);
  });

  it('the two differ in their attribute lists alone, the status read\'s a part of the other\'s', () => {
    const one = itemAt(status, 0);
    const other = itemAt(roleAndStatus, 0);
    const withoutAttributes = ({ condition }: typeof one) => ({ ...condition, 'ForAllValues:StringEquals': {} });
    expect(withoutAttributes(one)).toStrictEqual(withoutAttributes(other));
    const wider = new Set(other.condition['ForAllValues:StringEquals']['dynamodb:Attributes']);
    expect(one.condition['ForAllValues:StringEquals']['dynamodb:Attributes'].every((name) => wider.has(name))).toBe(true);
  });

  it('each list is exactly what the stream Lambda projects (its status read, and its member row with it)', () => {
    const statusRead = streamList('workspace-status.ts', 'STATUS_READ_ATTRIBUTES');
    const memberRead = streamList('workspace-member.ts', 'MEMBER_ROW_ATTRIBUTES');
    expect(status[0]?.condition['ForAllValues:StringEquals']['dynamodb:Attributes']).toStrictEqual(statusRead);
    expect([...(roleAndStatus[0]?.condition['ForAllValues:StringEquals']['dynamodb:Attributes'] ?? [])].sort(byCodeUnit))
      .toStrictEqual([...new Set([...statusRead, ...memberRead])].sort(byCodeUnit));
  });
});
