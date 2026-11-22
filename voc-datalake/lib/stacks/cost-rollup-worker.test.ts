/**
 * voc-cost-rollup (lib/stacks/cost-rollup-worker.ts, VocProcessingStack; docs/multi-workspace.md "Cost per
 * workspace"): its settings, its schedule and every statement of its role, pinned.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { WORKSPACE_STATUS_READ_CONDITION } from '../test-support/iam-statements';
import { itemAt } from '../test-support/guards';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import {
  findWorkerFunction, FunctionPropertiesSchema, pinnedStatements, RetryConfigSchema, ScheduleSchema,
} from '../test-support/worker-function';
import { byCodeUnit } from '../utils/compare';
import { COST_PARTITIONS } from './cost-rollup-worker';

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

const ONE = `ws_${'?'.repeat(26)}`;
const worker = () => findWorkerFunction(template, 'voc-cost-rollup-');
/** The role's statements, pinned, actions sorted (the audit-row guard's Denies, every writer's of voc-aggregates, left
 *  out). */
const statements = () => pinnedStatements(template, worker().Role['Fn::GetAtt'][0]);
const on = (service: string) => statements().filter((s) => s.actions.some((action) => action.startsWith(service)));


describe('the voc-cost-rollup job', () => {
  it('reserves no concurrency, which a Workshop Studio account cannot spare (CHANGELOG 7.23.00, Known issues)', () => {
    const rollups = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => FunctionPropertiesSchema.parse(fn).Properties)
      .filter((properties) => JSON.stringify(properties['FunctionName'] ?? '').includes('voc-cost-rollup-'));
    expect(rollups).toHaveLength(1);
    const rollup = itemAt(rollups, 0);
    expect(rollup).not.toHaveProperty('ReservedConcurrentExecutions');
    expect([rollup['MemorySize'], rollup['Timeout']]).toStrictEqual([256, 900]);
  });

  it('runs the rollup handler 15 minutes at most, with no async retry', () => {
    expect(worker().Handler).toBe('jobs/cost_rollup/handler.lambda_handler');
    const retries = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => RetryConfigSchema.parse(resource).Properties)
      .filter((config) => config.FunctionName.Ref.startsWith('CostRollupWorkerCostRollup'))
      .map((config) => config.MaximumRetryAttempts);
    expect(retries).toStrictEqual([0]);
  });

  it('is told its two tables and the log groups it reads, and no secret', () => {
    const variables = worker().Environment.Variables;
    expect(Object.keys(variables).sort(byCodeUnit)).toStrictEqual(['AGGREGATES_TABLE', 'LOG_LEVEL',
      'POWERTOOLS_SERVICE_NAME', 'SYSTEM_LOG_GROUP_PATTERN', 'WORKSPACES_TABLE']);
    expect(JSON.stringify(variables.SYSTEM_LOG_GROUP_PATTERN)).toContain('/aws/lambda/voc-*-');
  });

  it('ticks at 02:15 UTC in scheduled mode', () => {
    const schedules = Object.keys(template.findResources('AWS::Events::Rule'))
      .filter((id) => id.startsWith('CostRollupWorkerCostRollupSchedule'))
      .map((id) => ScheduleSchema.parse(template.toJSON().Resources[id]));
    expect(schedules).toStrictEqual([{ expression: 'cron(15 2 * * ? *)', input: JSON.stringify({ mode: 'scheduled' }) }]);
  });

  it('lists the log groups, queries the deployment\'s voc-* Lambda groups only, and polls and stops by query id', () => {
    const search = on('logs:').filter((s) => !s.actions.includes('logs:PutLogEvents')).map((s) => ({
      actions: s.actions, condition: s.condition,
      // Each granted log-group name (the account and region are tokens), or `*`.
      groups: s.resource === '"*"' ? ['*'] : [...s.resource.matchAll(/log-group:([^"]*)"/g)].map((match) => match[1]),
    }));
    expect(search).toStrictEqual([
      { actions: ['logs:DescribeLogGroups'], condition: undefined, groups: ['*'] },
      { actions: ['logs:StartQuery'], condition: undefined, groups: ['/aws/lambda/voc-*-', '/aws/lambda/voc-*-'] },
      { actions: ['logs:GetQueryResults', 'logs:StopQuery'], condition: undefined, groups: ['*'] },
    ]);
    // The groups themselves and their streams (`…:*`), as System → Logs is granted them.
    expect(on('logs:StartQuery')[0]?.resource).toContain(':*"');
  });

  it('puts only the cost rows in voc-aggregates, one workspace id each, and reads only a workspace\'s status', () => {
    expect(COST_PARTITIONS).toStrictEqual([`WS#${ONE}#COST`, 'DEPLOYMENT#COST', 'UNATTRIBUTED#COST']);
    const dynamodb = on('dynamodb:').map(({ actions, condition, resource }) => ({ actions, condition,
      table: /ExportsOutputFnGetAtt([A-Z][a-z]+)/.exec(resource)?.[1] ?? resource }));
    dynamodb.sort((a, b) => byCodeUnit(a.table, b.table));
    expect(dynamodb).toStrictEqual([
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': COST_PARTITIONS } },
        table: 'Aggregates' },
      { actions: ['dynamodb:GetItem'], condition: WORKSPACE_STATUS_READ_CONDITION, table: 'Workspaces' },
    ]);
  });

  it('calls no model and reaches nothing but its logs, the two tables and the key', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0] ?? ''));
    expect([...services].sort(byCodeUnit)).toStrictEqual(['dynamodb', 'kms', 'logs']);
    expect(statements().filter((s) => s.effect !== 'Allow')).toStrictEqual([]);
  });
});
