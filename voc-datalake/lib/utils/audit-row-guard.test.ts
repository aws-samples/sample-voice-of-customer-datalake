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
  'ConversationsTable', 'WorkspacesTable'] as const;
const WRITES = /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem|\*)$/;
const AUDIT_CONDITION = { 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#*'] } };

/** Table → the roles that may PUT an audit row there (the audit writers; the settings API only `AUDIT#delete`, the
 *  users API only `AUDIT#platform-admins`). */
const AUDIT_WRITERS: Record<(typeof GUARDED_TABLES)[number], string[]> = {
  AggregatesTable: ['VocApiStack/SettingsLambdaRole', 'VocApiStack/UsersLambdaRole',
    'VocProcessingStack/RetentionWorkerRetentionRole'],
  ProjectsTable: ['VocApiStack/PersonaGeneratorRole', 'VocApiStack/ProjectsLambdaRole'],
  ParticipantsTable: ['VocApiStack/EngagementLambdaRole'],
  FeatureRequestsTable: ['VocApiStack/EngagementLambdaRole'],
  ConversationsTable: ['VocApiStack/ChatLambdaRole'],
  // A platform admin's entry, a workspace's creation and its membership changes (AUDIT#WS#<ws>); the users API a
  // deleted user's membership removals (AUDIT#WS#* only); every other role writing voc-workspaces (voc-retention's
  // de-identification) gets the forge Deny. The data-path APIs that resolve X-Workspace-Id (the metrics API, the
  // feedback edits, the integrations and scrapers APIs, the feedback forms' signed-in routes) write a platform admin's
  // entry (AUDIT#WS#* only); the feedback forms also write a workspace form's `form_deleted` row there, before the
  // delete. The settings API's erasure routes only read memberships (they never let a platform admin enter), so it
  // writes nothing there.
  WorkspacesTable: ['VocApiStack/FeedbackEditLambdaRole', 'VocApiStack/FeedbackFormLambdaRole',
    'VocApiStack/IntegrationsLambdaRole',
    'VocApiStack/MetricsLambdaRole', 'VocApiStack/ScrapersLambdaRole', 'VocApiStack/UsersLambdaRole',
    'VocApiStack/WorkspacesLambdaRole'],
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
    // Each written table sits in ONE of the two Denies (its ARN written once): the change-Deny for the tables the
    // role writes audit rows in, the write-Deny (change actions + puts) for every other one. Both carry the change
    // actions and the AUDIT# condition, so together they cover every table the role writes.
    const changeActions = ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'];
    const denies = [AUDIT_DENY_CHANGE_SID, AUDIT_DENY_WRITE_SID]
      .map((sid) => statements.find((statement) => statement.Sid === sid))
      .filter((statement) => statement !== undefined);
    for (const deny of denies) {
      expect(deny.Effect).toBe('Deny');
      expect(changeActions.filter((action) => !actionsOf(deny).includes(action))).toStrictEqual([]);
      expect(deny.Condition).toStrictEqual(AUDIT_CONDITION);
    }
    expect(denies.flatMap(tablesOf).sort(byCodeUnit)).toStrictEqual(writtenBy(statements));
  });

  it.each(GUARDED_TABLES)('%s: only its audit writers may put (or batch-write) an audit row', (table) => {
    const mayPut = writers
      .filter(([, statements]) => writtenBy(statements).includes(table))
      .filter(([, statements]) => !tablesOf(denied(statements, AUDIT_DENY_WRITE_SID)).includes(table))
      .map(([role]) => role).sort(byCodeUnit);
    expect(mayPut).toStrictEqual(AUDIT_WRITERS[table]);
  });

  it('a non-writer\'s one deny names every write (put, batch, update, delete), on audit keys only', () => {
    const deny = denied(byRole.get('VocApiStack/ScrapersLambdaRole') ?? [], AUDIT_DENY_WRITE_SID);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit))
      .toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
    expect(deny.Condition).toStrictEqual(AUDIT_CONDITION);
  });

  it.each([
    ['VocApiStack/SettingsLambdaRole', 'AUDIT#delete'],
    ['VocApiStack/UsersLambdaRole', 'AUDIT#platform-admins'],
  ])('%s may put only %s in voc-aggregates (no retention row, no tombstone, no other audit)', (role, partition) => {
    const deny = denied(byRole.get(role) ?? [], AUDIT_DENY_OTHER_PARTITION_SID);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:PutItem']);
    expect(tablesOf(deny)).toStrictEqual(['AggregatesTable']);
    expect(deny.Condition).toStrictEqual({ ...AUDIT_CONDITION,
      'ForAnyValue:StringNotEquals': { 'dynamodb:LeadingKeys': [partition] } });
  });

  it('only the settings, users, metrics, feedback-edit, feedback-form, integrations and scrapers APIs carry a one-partition deny', () => {
    const holders = [...byRole].filter(([, statements]) => denied(statements, AUDIT_DENY_OTHER_PARTITION_SID) !== NO_STATEMENT);
    expect(holders.map(([role]) => role).sort(byCodeUnit)).toStrictEqual([
      'VocApiStack/FeedbackEditLambdaRole', 'VocApiStack/FeedbackFormLambdaRole', 'VocApiStack/IntegrationsLambdaRole',
      'VocApiStack/MetricsLambdaRole',
      'VocApiStack/ScrapersLambdaRole', 'VocApiStack/SettingsLambdaRole', 'VocApiStack/UsersLambdaRole']);
  });

  it.each(['VocApiStack/MetricsLambdaRole', 'VocApiStack/FeedbackEditLambdaRole', 'VocApiStack/IntegrationsLambdaRole',
    'VocApiStack/ScrapersLambdaRole', 'VocApiStack/FeedbackFormLambdaRole'])(
    '%s may put only AUDIT#WS#* rows in voc-workspaces and change or remove none',
    (role) => {
      const statements = byRole.get(role) ?? [];
      const other = denied(statements, AUDIT_DENY_OTHER_PARTITION_SID);
      expect(tablesOf(other)).toStrictEqual(['WorkspacesTable']);
      expect(other.Condition).toStrictEqual({ ...AUDIT_CONDITION,
        'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*'] } });
      const change = denied(statements, AUDIT_DENY_CHANGE_SID);
      expect(tablesOf(change)).toContain('WorkspacesTable');
      expect(actionsOf(change).sort(byCodeUnit))
        .toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem']);
    },
  );

  it('the users API may not change or remove a platform-admin or a workspace audit row', () => {
    const deny = denied(byRole.get('VocApiStack/UsersLambdaRole') ?? [], AUDIT_DENY_CHANGE_SID);
    expect({ effect: deny.Effect, actions: actionsOf(deny).sort(byCodeUnit), tables: tablesOf(deny) }).toStrictEqual({
      effect: 'Deny', actions: ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
      tables: ['AggregatesTable', 'WorkspacesTable'],
    });
  });

  it('the users API may put only AUDIT#WS#* rows in voc-workspaces (a pattern: StringNotLike)', () => {
    const deny = denied(byRole.get('VocApiStack/UsersLambdaRole') ?? [], `${AUDIT_DENY_OTHER_PARTITION_SID}2`);
    expect(deny.Effect).toBe('Deny');
    expect(actionsOf(deny).sort(byCodeUnit)).toStrictEqual(['dynamodb:BatchWriteItem', 'dynamodb:PutItem']);
    expect(tablesOf(deny)).toStrictEqual(['WorkspacesTable']);
    expect(deny.Condition).toStrictEqual({ ...AUDIT_CONDITION,
      'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*'] } });
  });

  it('voc-retention may not put, change or remove an audit row in voc-workspaces (it de-identifies members only)', () => {
    const deny = denied(byRole.get('VocProcessingStack/RetentionWorkerRetentionRole') ?? [], AUDIT_DENY_WRITE_SID);
    expect(tablesOf(deny)).toContain('WorkspacesTable');
    expect(actionsOf(deny)).toContain('dynamodb:PutItem');
  });

  it('the workspaces API may not change or remove an entry audit row in voc-workspaces', () => {
    const statements = byRole.get('VocApiStack/WorkspacesLambdaRole') ?? [];
    const deny = denied(statements, AUDIT_DENY_CHANGE_SID);
    expect({ effect: deny.Effect, actions: actionsOf(deny).sort(byCodeUnit), tables: tablesOf(deny) }).toStrictEqual({
      effect: 'Deny', actions: ['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
      tables: ['WorkspacesTable'],
    });
    expect(deny.Condition).toStrictEqual(AUDIT_CONDITION);
    // Its export routes write their job and lock rows in voc-aggregates, where it writes no audit row: it may
    // forge, change or remove none there (lib/stacks/api-workspace-export.ts).
    expect(tablesOf(denied(statements, AUDIT_DENY_WRITE_SID))).toStrictEqual(['AggregatesTable']);
  });

  it('the export job may not put, change or remove an audit row in voc-aggregates, and writes no other guarded table', () => {
    const statements = byRole.get('VocProcessingStack/WorkspaceExportWorkerExportRole') ?? [];
    expect(writtenBy(statements)).toStrictEqual(['AggregatesTable']);
    expect(tablesOf(denied(statements, AUDIT_DENY_WRITE_SID))).toStrictEqual(['AggregatesTable']);
    expect(denied(statements, AUDIT_DENY_CHANGE_SID)).toBe(NO_STATEMENT);
  });

  it('leaves a read-only role alone', () => {
    // A role that writes none of the audit tables holds no audit Deny at all.
    const readOnly = [...byRole].filter(([, statements]) => writtenBy(statements).length === 0);
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.filter(([, statements]) => denied(statements, AUDIT_DENY_CHANGE_SID) !== NO_STATEMENT
      || denied(statements, AUDIT_DENY_WRITE_SID) !== NO_STATEMENT).map(([role]) => role)).toStrictEqual([]);
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

  it('a putter that deletes nothing is denied puts, changes and removals (one statement per table)', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'))))
      .toStrictEqual([AUDIT_DENY_WRITE_SID]);
  });

  it('a delete grant does not make a role the audit writer (only the named writers are)', () => {
    expect(sids(guarded((table, role) => table.grantReadWriteData(role)))).toStrictEqual([AUDIT_DENY_WRITE_SID]);
  });

  it('a named writer keeps its puts, also with a delete grant', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'), ['/R']))).toStrictEqual([AUDIT_DENY_CHANGE_SID]);
    expect(sids(guarded((table, role) => table.grantReadWriteData(role), ['/R']))).toStrictEqual([AUDIT_DENY_CHANGE_SID]);
  });

  it('a writer of one audit partition is denied puts on every other one', () => {
    expect(sids(guarded((table, role) => table.grant(role, 'dynamodb:PutItem'), ['/R'], 'AUDIT#delete')))
      .toStrictEqual([AUDIT_DENY_CHANGE_SID, AUDIT_DENY_OTHER_PARTITION_SID]);
  });

  it('a writer of one audit partition pattern is denied puts outside it with StringNotLike', () => {
    const template = guarded((table, role) => table.grant(role, 'dynamodb:PutItem'), ['/R'], 'AUDIT#WS#*');
    const deny = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap((policy) => IamPolicySchema.parse(policy).Properties.PolicyDocument.Statement)
      .find((statement) => statement.Sid === AUDIT_DENY_OTHER_PARTITION_SID);
    expect(deny?.Condition).toStrictEqual({ ...AUDIT_CONDITION,
      'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*'] } });
  });

  it('a reader of the guarded table gets nothing (the unguarded table it writes does not count)', () => {
    expect(sids(guarded((table, role) => table.grantReadData(role)))).toStrictEqual([]);
  });
}, SYNTH_TIMEOUT_MS);
