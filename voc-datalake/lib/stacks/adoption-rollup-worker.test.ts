/**
 * voc-adoption-rollup (lib/stacks/adoption-rollup-worker.ts, VocProcessingStack, 7.70.00; docs/leadership-view.md):
 * its settings, its schedule and every statement of its role, pinned, with what it may not do: no Scan, no GetItem,
 * no write but the ADOPTION puts, no read of voc-feedback, no model.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IamPolicySchema, isAttachedToRole, isAuditRowGuardStatement, statementActions } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { findWorkerFunction } from '../test-support/worker-function';
import { byCodeUnit } from '../utils/compare';
import { ADOPTION_PARTITIONS, PROJECT_QUERY_ATTRIBUTES, PROJECT_QUERY_PARTITIONS } from './adoption-rollup-worker';

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

const ONE = `ws_${'?'.repeat(26)}`;
const worker = () => findWorkerFunction(template, 'voc-adoption-rollup-');
interface Statement { sid: string | undefined; effect: string; actions: string[]; resource: string; condition: unknown }
const StatementSidSchema = z.object({ Sid: z.string().optional() }).loose();

function statements(): Statement[] {
  const roleId = worker().Role['Fn::GetAtt'][0];
  const found: Statement[] = [];
  for (const resource of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const policy = IamPolicySchema.parse(resource).Properties;
    if (!isAttachedToRole(policy, roleId)) continue;
    // The audit-row guard's Denies are every writer's of voc-aggregates (pinned by audit-row-guard.test.ts).
    for (const statement of policy.PolicyDocument.Statement.filter((s) => !isAuditRowGuardStatement(s))) {
      found.push({ sid: StatementSidSchema.parse(statement).Sid, effect: statement.Effect ?? 'Allow',
        actions: [...statementActions(statement)].sort(byCodeUnit), resource: JSON.stringify(statement.Resource),
        condition: statement.Condition });
    }
  }
  return found;
}
const dynamodbStatements = () => statements().filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')));
/** The table a statement names (the fixture's table id) and the index after it, if any. */
function target(resource: string): string {
  const table = /ExportsOutputFnGetAtt([A-Z][a-z]+)/.exec(resource)?.[1] ?? resource;
  const index = /\/index\/([a-z0-9-]+)/.exec(resource)?.[1];
  return index === undefined ? table : `${table}/${index}`;
}
const projected = (partitions: string[], attributes: string[]) => ({
  'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions },
  'ForAllValues:StringEquals': { 'dynamodb:Attributes': attributes },
  StringEquals: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
});

const ScheduleSchema = z.object({
  Properties: z.object({ ScheduleExpression: z.string(), Targets: z.tuple([z.object({ Input: z.string() })]) }),
}).transform(({ Properties }) => ({ expression: Properties.ScheduleExpression, input: Properties.Targets[0].Input }));
const FunctionPropertiesSchema = z.object({ Properties: z.record(z.string(), z.unknown()) });
const InvokeConfigSchema = z.object({
  Properties: z.object({ FunctionName: z.object({ Ref: z.string() }), MaximumRetryAttempts: z.number() }).loose(),
});

describe('the voc-adoption-rollup job', () => {
  it('runs the rollup handler 15 minutes at most at 512 MB, with no reserved concurrency and no async retry', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((resource) => FunctionPropertiesSchema.parse(resource).Properties)
      .filter((properties) => JSON.stringify(properties['FunctionName'] ?? '').includes('voc-adoption-rollup-'));
    expect(fn.map((properties) => [properties['Handler'], properties['MemorySize'], properties['Timeout']]))
      .toStrictEqual([['jobs/adoption_rollup/handler.lambda_handler', 512, 900]]);
    expect(fn.filter((properties) => 'ReservedConcurrentExecutions' in properties)).toStrictEqual([]);
    const retries = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => InvokeConfigSchema.parse(resource).Properties)
      .filter((config) => config.FunctionName.Ref.startsWith('AdoptionRollupWorkerAdoptionRollup'))
      .map((config) => config.MaximumRetryAttempts);
    expect(retries).toStrictEqual([0]);
  });

  it('is told its five tables and nothing else', () => {
    expect(Object.keys(worker().Environment.Variables).sort(byCodeUnit)).toStrictEqual(['AGENTS_TABLE',
      'AGGREGATES_TABLE', 'CONVERSATIONS_TABLE', 'LOG_LEVEL', 'POWERTOOLS_SERVICE_NAME', 'PROJECTS_TABLE',
      'WORKSPACES_TABLE']);
  });

  it('ticks at 03:05 UTC in scheduled mode: an EventBridge rule, no fixed cost', () => {
    const schedules = Object.keys(template.findResources('AWS::Events::Rule'))
      .filter((id) => id.startsWith('AdoptionRollupWorkerAdoptionRollupSchedule'))
      .map((id) => ScheduleSchema.parse(template.toJSON().Resources[id]));
    expect(schedules).toStrictEqual([{ expression: 'cron(5 3 * * ? *)', input: JSON.stringify({ mode: 'scheduled' }) }]);
  });

  it('reads by projected Query only and puts only the ADOPTION rows, one workspace id each', () => {
    expect(ADOPTION_PARTITIONS).toStrictEqual(['ADOPTION#ROLLUP', `WS#${ONE}#ADOPTION#ROLLUP`]);
    const grants = dynamodbStatements().map(({ sid, actions, condition, resource }) => ({
      sid, actions, condition, target: target(resource) }));
    grants.sort((a, b) => byCodeUnit(`${a.target}${a.sid ?? ''}`, `${b.target}${b.sid ?? ''}`));
    expect(grants).toStrictEqual([
      { sid: 'QueryAgentListing', actions: ['dynamodb:Query'], target: 'Agents/gsi1-by-agents-listing',
        condition: projected(['AGENTS'], ['pk', 'sk', 'gsi1pk', 'gsi1sk']) },
      { sid: 'QueryAgentRuns', actions: ['dynamodb:Query'], target: 'Agents',
        condition: projected(['AGENT#*'], ['pk', 'sk', 'started_at']) },
      { sid: undefined, actions: ['dynamodb:PutItem'], target: 'Aggregates',
        condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ADOPTION_PARTITIONS } } },
      { sid: 'CountAssistantConversations', actions: ['dynamodb:Query'], target: 'Conversations/gsi1-by-kind-updated-at',
        condition: { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['assistant'] },
          StringEquals: { 'dynamodb:Select': 'COUNT' } } },
      { sid: 'QueryProjects', actions: ['dynamodb:Query'], target: 'Projects',
        condition: projected(PROJECT_QUERY_PARTITIONS, PROJECT_QUERY_ATTRIBUTES) },
      { sid: 'QueryWorkspaceListing', actions: ['dynamodb:Query'], target: 'Workspaces',
        condition: projected(['WORKSPACES'], ['pk', 'sk', 'workspace_id', 'status']) },
    ]);
  });

  it('never Scans, gets, updates, deletes or batches, and never reaches voc-feedback', () => {
    const actions = new Set(dynamodbStatements().flatMap((s) => s.actions));
    expect([...actions].sort(byCodeUnit)).toStrictEqual(['dynamodb:PutItem', 'dynamodb:Query']);
    expect(dynamodbStatements().map((s) => target(s.resource)).filter((t) => t.startsWith('Feedback'))).toStrictEqual([]);
  });

  it('calls no model and reaches nothing but its tables, the key and its logs', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0] ?? ''));
    expect([...services].sort(byCodeUnit).filter((service) => service !== 'logs')).toStrictEqual(['dynamodb', 'kms']);
    expect(statements().filter((s) => s.effect !== 'Allow')).toStrictEqual([]);
  });

  it('holds a project Query to exactly the attributes the code projects (lambda/shared/adoption_rollup.py)', () => {
    const source = readFileSync(path.join(__dirname, '../../lambda/shared/adoption_rollup.py'), 'utf8');
    const listed = /PROJECT_ATTRIBUTES: Final = \(([^)]*)\)/s.exec(source)?.[1] ?? '';
    const named = [...listed.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    // The two from shared/adoption_validation.py, named by their constants there, and the registry's delete mark.
    expect([...named, 'synthetic', 'validation', 'results', 'deleted_at'].sort(byCodeUnit))
      .toStrictEqual([...PROJECT_QUERY_ATTRIBUTES].sort(byCodeUnit));
  });
});
