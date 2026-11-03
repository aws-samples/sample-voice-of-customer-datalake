/**
 * The audit-row guard (lib/utils/audit-row-guard.ts) on the whole app: every role that can write a table holding
 * `AUDIT#*` rows is denied changing or removing them there, and only the audit writers may put one.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { afterAll, describe, expect, it } from 'vitest';

import { IamPolicySchema, TemplateResourcesSchema, type IamStatement } from '../test-support/iam-statements';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import {
  AUDIT_DENY_CHANGE_SID, AUDIT_DENY_OTHER_PARTITION_SID, AUDIT_DENY_WRITE_SID, applyAuditRowGuard, type NamedAuditWriter,
} from './audit-row-guard';
import { byCodeUnit } from './compare';

const GUARDED_TABLES = ['AggregatesTable', 'ProjectsTable', 'ParticipantsTable', 'FeatureRequestsTable',
  'ConversationsTable'] as const;
const WRITES = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/;
const AUDIT_CONDITION = { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#*'] } };

/** Table → the roles that may PUT an audit row there (the audit writers; the settings API only `AUDIT#delete`). */
const AUDIT_WRITERS: Record<(typeof GUARDED_TABLES)[number], string[]> = {
  AggregatesTable: ['VocApiStack/SettingsLambdaRole', 'VocProcessingStack/RetentionWorkerRetentionRole'],
  ProjectsTable: ['VocApiStack/PersonaGeneratorRole', 'VocApiStack/ProjectsLambdaRole'],
  ParticipantsTable: ['VocApiStack/EngagementLambdaRole'],
  FeatureRequestsTable: ['VocApiStack/EngagementLambdaRole'],
  ConversationsTable: ['VocApiStack/ChatLambdaRole'],
};

type Statement = IamStatement;

const synthed = synthApp();
afterAll(cleanupAssemblyDirs);

/** `<Stack>/<RoleId>` → its default policy's statements. */
function statementsByRole(): Map<string, Statement[]> {
  const out = new Map<string, Statement[]>();
  for (const stack of synthed.stackNames) {
    for (const [id, resource] of Object.entries(TemplateResourcesSchema.parse(synthed.template(stack)).Resources)) {
      const policy = IamPolicySchema.safeParse(resource);
      if (!policy.success) continue;
      const role = `${stack}/${id.replace(/DefaultPolicy[0-9A-F]{8}$/, '')}`;
      out.set(role, [...(out.get(role) ?? []), ...policy.data.Properties.PolicyDocument.Statement]);
    }
  }
  return out;
}
const byRole = statementsByRole();

/** The guarded tables a statement names (by logical id, in a GetAtt or an import). */
const tablesOf = (statement: Statement): string[] =>
  GUARDED_TABLES.filter((table) => new RegExp(`${table}[0-9A-F]{8}`).test(JSON.stringify(statement.Resource)));
const actionsOf = (statement: Statement): string[] => [statement.Action].flat();

function writtenBy(statements: Statement[]): string[] {
  return [...new Set(statements
    .filter((s) => (s.Effect ?? 'Allow') === 'Allow' && actionsOf(s).some((a) => WRITES.test(a)))
    .flatMap(tablesOf))].sort(byCodeUnit);
}
/** What {@link denied} answers when the role has no statement with that sid. */
const NO_STATEMENT: Statement = { Action: [], Resource: undefined };
const denied = (statements: Statement[], sid: string): Statement => statements.find((s) => s.Sid === sid) ?? NO_STATEMENT;

describe('audit rows (AUDIT#*) across every stack', () => {
  const writers = [...byRole].filter(([, statements]) => writtenBy(statements).length > 0);

  it('covers every role that writes a table holding audit rows', () => {
    expect(writers.length).toBeGreaterThan(30);
  });

  it.each(writers)('%s may not change or remove an audit row in any table it writes', (_role, statements) => {
    const deny = denied(statements, AUDIT_DENY_CHANGE_SID);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem']);
    expect(deny.Condition).toStrictEqual(AUDIT_CONDITION);
    expect(tablesOf(deny).sort(byCodeUnit)).toStrictEqual(writtenBy(statements));
  });

  it.each(GUARDED_TABLES)('%s: only its audit writers may put (or batch-write) an audit row', (table) => {
    const mayPut = writers
      .filter(([, statements]) => writtenBy(statements).includes(table))
      .filter(([, statements]) => !tablesOf(denied(statements, AUDIT_DENY_WRITE_SID)).includes(table))
      .map(([role]) => role).sort(byCodeUnit);
    expect(mayPut).toStrictEqual(AUDIT_WRITERS[table]);
  });

  it('a non-writer\'s put deny names PutItem and BatchWriteItem, on audit keys only', () => {
    const deny = denied(byRole.get('VocApiStack/ScrapersLambdaRole') ?? [], AUDIT_DENY_WRITE_SID);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:PutItem']);
    expect(deny.Condition).toStrictEqual(AUDIT_CONDITION);
  });

  it('the settings API may put only AUDIT#delete in voc-aggregates (no retention row, no tombstone)', () => {
    const deny = denied(byRole.get('VocApiStack/SettingsLambdaRole') ?? [], AUDIT_DENY_OTHER_PARTITION_SID);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:PutItem']);
    expect(tablesOf(deny)).toStrictEqual(['AggregatesTable']);
    expect(deny.Condition).toStrictEqual({ ...AUDIT_CONDITION,
      'ForAnyValue:StringNotEquals': { 'dynamodb:LeadingKeys': ['AUDIT#delete'] } });
  });

  it('only the settings API carries a one-partition deny', () => {
    const holders = [...byRole].filter(([, statements]) => denied(statements, AUDIT_DENY_OTHER_PARTITION_SID) !== NO_STATEMENT);
    expect(holders.map(([role]) => role)).toStrictEqual(['VocApiStack/SettingsLambdaRole']);
  });

  it('leaves a read-only role alone', () => {
    // The metrics API only reads voc-aggregates, so it holds no audit Deny at all.
    expect(denied(byRole.get('VocApiStack/MetricsLambdaRole') ?? [], AUDIT_DENY_CHANGE_SID)).toBe(NO_STATEMENT);
  });
}, SYNTH_TIMEOUT_MS);

describe('applyAuditRowGuard (one stack)', () => {
  function guarded(grant: (table: dynamodb.Table, role: iam.Role) => void, writerSuffixes: string[] = [],
    partitionKey?: string): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'S');
    const table = new dynamodb.Table(stack, 'T', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
    const other = new dynamodb.Table(stack, 'O', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } });
    const role = new iam.Role(stack, 'R', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    grant(table, role);
    other.grantReadWriteData(role);
    const writer: NamedAuditWriter = { table, rolePathSuffixes: writerSuffixes, partitionKey };
    applyAuditRowGuard(app, { tables: [table], writers: [writer] });
    return Template.fromStack(stack);
  }
  const sids = (template: Template): string[] => Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap((policy) => IamPolicySchema.parse(policy).Properties.PolicyDocument.Statement)
    .flatMap((statement) => statement.Sid ?? []).sort(byCodeUnit);

  it('a putter that deletes nothing is denied puts, changes and removals', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'))))
      .toStrictEqual([AUDIT_DENY_CHANGE_SID, AUDIT_DENY_WRITE_SID]);
  });

  it('a delete grant does not make a role the audit writer (only the named writers are)', () => {
    expect(sids(guarded((table, role) => table.grantReadWriteData(role)))).toStrictEqual([AUDIT_DENY_CHANGE_SID, AUDIT_DENY_WRITE_SID]);
  });

  it('a named writer keeps its puts, also with a delete grant', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'), ['/R']))).toStrictEqual([AUDIT_DENY_CHANGE_SID]);
    expect(sids(guarded((table, role) => table.grantReadWriteData(role), ['/R']))).toStrictEqual([AUDIT_DENY_CHANGE_SID]);
  });

  it('a writer of one audit partition is denied puts on every other one', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'), ['/R'], 'AUDIT#delete')))
      .toStrictEqual([AUDIT_DENY_CHANGE_SID, AUDIT_DENY_OTHER_PARTITION_SID]);
  });

  it('a reader of the guarded table gets nothing (the unguarded table it writes does not count)', () => {
    expect(sids(guarded((table, role) => table.grantReadData(role)))).toStrictEqual([]);
  });
}, SYNTH_TIMEOUT_MS);
