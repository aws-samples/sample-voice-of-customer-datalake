/**
 * voc-trial-expiry and its schedules (7.71.00; lib/stacks/trial-expiry.ts, docs/multi-workspace.md "Trial workspaces"):
 * the job, its role pinned statement by statement with the negative pins (NO delete action of any kind but the existing
 * plugin disable's DeleteItem, held to `PLUGIN#*`), the trials group, and the scheduler's role that may invoke the job
 * and nothing else. On a stack of its own with VocCoreStack's kinds of table and key, as bin/voc-datalake.ts adds it to
 * VocProcessingStack.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { itemAt } from '../test-support/guards';
import { IamPolicySchema, isAttachedToRole, isAuditRowGuardStatement, statementActions } from '../test-support/iam-statements';
import { findWorkerFunction } from '../test-support/worker-function';
import { applyAppAspects } from '../utils/app-aspects';
import { byCodeUnit } from '../utils/compare';
import { addTrialExpiry, TRIAL_SCHEDULE_PREFIX } from './trial-expiry';

const ONE = `ws_${'?'.repeat(26)}`;
let template: Template;

beforeAll(() => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Trials', { env: { account: '111111111111', region: 'us-east-1' } });
  const table = (id: string) => new dynamodb.Table(stack, id, {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  const workspacesTable = table('Workspaces');
  const aggregatesTable = table('Aggregates');
  addTrialExpiry(stack, {
    workspacesTable, aggregatesTable, kmsKey: new kms.Key(stack, 'Key'), enabledSources: ['webscraper'],
    layer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', 'arn:aws:lambda:us-east-1:111111111111:layer:deps:1'),
  });
  // The app's rewrites (the audit-row guard among them), as bin/voc-datalake.ts applies them.
  applyAppAspects(app, { auditRowTables: { workspacesTable, aggregatesTable } });
  template = Template.fromStack(stack);
});

interface Statement { effect: string; sid?: string; actions: string[]; resource: string; condition: unknown }
const RoleIdSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) });

function statementsOf(roleId: string, { guard = false } = {}): Statement[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((policy) => isAttachedToRole(policy, roleId))
    .flatMap((policy) => policy.PolicyDocument.Statement)
    .filter((statement) => guard === isAuditRowGuardStatement(statement))
    .map((statement) => ({ effect: statement.Effect ?? 'Allow', sid: statement.Sid,
      actions: [...statementActions(statement)].sort(byCodeUnit), resource: JSON.stringify(statement.Resource),
      condition: statement.Condition }));
}
const job = () => findWorkerFunction(template, 'voc-trial-expiry-');
const jobRole = () => RoleIdSchema.parse(job().Role)['Fn::GetAtt'][0];
const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });
const on = (table: string) => (s: Statement) => s.resource.includes(table);

describe('the voc-trial-expiry job', () => {
  it('runs the trial expiry handler, 256 MB for 5 minutes, told its two tables and the deployment\'s plugins', () => {
    expect(job().Handler).toBe('jobs/trial_expiry/handler.lambda_handler');
    const variables = job().Environment.Variables;
    expect(Object.keys(variables).sort(byCodeUnit)).toStrictEqual(['AGGREGATES_TABLE', 'ENABLED_SOURCES', 'LOG_LEVEL',
      'POWERTOOLS_SERVICE_NAME', 'WORKSPACES_TABLE']);
    expect(variables.ENABLED_SOURCES).toBe('["webscraper"]');
    const [fn] = Object.values(template.findResources('AWS::Lambda::Function'));
    expect(fn).toMatchObject({ Properties: { MemorySize: 256, Timeout: 300 } });
  });

  it('may read the trial, write `trial` alone, audit, check the workspace, and turn plugins and forms off', () => {
    const shape = statementsOf(jobRole()).filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')))
      .map((s) => ({ actions: s.actions, condition: s.condition, table: on('Workspaces')(s) ? 'workspaces' : 'aggregates' }))
      .sort((a, b) => byCodeUnit(a.table + a.actions.join(), b.table + b.actions.join()));
    expect(shape).toStrictEqual([
      { table: 'aggregates', actions: ['dynamodb:Query'], condition: keys([`WS#${ONE}#FEEDBACK_FORM`]) },
      { table: 'aggregates', actions: ['dynamodb:UpdateItem'], condition: {
        ...keys([`WS#${ONE}#FEEDBACK_FORM`]),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['enabled', 'pk', 'sk', 'updated_at', 'updated_by', 'write_count'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } } },
      { table: 'workspaces', actions: ['dynamodb:ConditionCheckItem'], condition: keys(['WS#*']) },
      // The existing plugin disable: its enable row's delete, and no other delete anywhere.
      { table: 'workspaces', actions: ['dynamodb:DeleteItem'], condition: keys(['PLUGIN#*']) },
      { table: 'workspaces', actions: ['dynamodb:GetItem'], condition: keys(['AUDIT#WS#*', 'PLUGIN#*', 'WS#*']) },
      { table: 'workspaces', actions: ['dynamodb:PutItem'], condition: keys(['AUDIT#WS#*']) },
      { table: 'workspaces', actions: ['dynamodb:UpdateItem'], condition: {
        ...keys(['WORKSPACES', 'WS#*']),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'trial'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } } },
    ]);
  });

  it('holds no delete action of any kind but the plugin disable\'s, and no S3, scheduler, Cognito, IAM or Lambda action', () => {
    const actions = statementsOf(jobRole()).filter((s) => s.effect === 'Allow').flatMap((s) => s.actions);
    const deletes = actions.filter((action) => /delete|remove|purge|destroy|terminate|batchwrite|\*/i.test(action));
    expect(deletes).toStrictEqual(['dynamodb:DeleteItem']);
    const deleteStatements = statementsOf(jobRole()).filter((s) => s.actions.includes('dynamodb:DeleteItem'));
    expect(deleteStatements.map((s) => s.condition)).toStrictEqual([keys(['PLUGIN#*'])]);
    // Its tables, their key, and the log and trace writes every function gets (lib/utils/app-aspects.ts).
    const services = new Set(actions.map((action) => action.split(':')[0] ?? ''));
    expect([...services].filter((service) => !['dynamodb', 'kms', 'logs', 'xray'].includes(service))).toStrictEqual([]);
  });

  it('is denied changing any audit row, and putting one outside AUDIT#WS#* (the audit-row guard names it a writer)', () => {
    const guard = statementsOf(jobRole(), { guard: true });
    expect(guard.every((s) => s.effect === 'Deny')).toBe(true);
    const outside = guard.find((s) => s.sid === 'DenyAuditRowWritesOutsideOwnPartition');
    expect(outside?.condition).toStrictEqual({ 'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#*'] },
      'ForAnyValue:StringNotLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*'] } });
    expect(guard.some((s) => s.actions.includes('dynamodb:DeleteItem') && s.actions.includes('dynamodb:UpdateItem')))
      .toBe(true);
  });
});

describe('the trials schedule group and the scheduler\'s role', () => {
  const GroupSchema = z.object({ Properties: z.object({ Name: z.unknown() }) });
  const TrustSchema = z.object({ Properties: z.object({
    RoleName: z.unknown(),
    AssumeRolePolicyDocument: z.object({ Statement: z.array(z.object({ Principal: z.unknown(), Condition: z.unknown() })) }),
  }) });

  it('makes one group named voc-trials-… (the names the workspaces API grants on)', () => {
    const groups = Object.values(template.findResources('AWS::Scheduler::ScheduleGroup')).map((g) => GroupSchema.parse(g));
    expect(groups).toHaveLength(1);
    expect(JSON.stringify(itemAt(groups, 0).Properties.Name)).toContain('voc-trials-');
    expect(TRIAL_SCHEDULE_PREFIX).toBe('voc-trial-');
    // No schedule at synth: each trial's is made at run time by the workspaces API.
    expect(Object.keys(template.findResources('AWS::Scheduler::Schedule'))).toStrictEqual([]);
  });

  const schedulerRole = () => Object.entries(template.findResources('AWS::IAM::Role'))
    .find(([id]) => id.startsWith('TrialExpirySchedulerRole')) ?? [];

  it('lets EventBridge Scheduler assume it for this account and this group only', () => {
    const trust = TrustSchema.parse(schedulerRole()[1]);
    expect(JSON.stringify(trust.Properties.RoleName)).toContain('voc-trial-scheduler-');
    const [statement] = trust.Properties.AssumeRolePolicyDocument.Statement;
    expect(statement?.Principal).toStrictEqual({ Service: 'scheduler.amazonaws.com' });
    expect(JSON.stringify(statement?.Condition)).toMatch(/aws:SourceAccount.*aws:SourceArn|aws:SourceArn.*aws:SourceAccount/s);
    expect(JSON.stringify(statement?.Condition)).toContain('schedule-group/voc-trials-');
  });

  it('may invoke the job and nothing else', () => {
    const statements = statementsOf(schedulerRole()[0] ?? '');
    expect(statements.map(({ actions, sid, resource }) => ({ actions, sid, job: resource.includes('TrialExpiryJob') })))
      .toStrictEqual([{ actions: ['lambda:InvokeFunction'], sid: 'InvokeTheTrialExpiry', job: true }]);
  });
});
