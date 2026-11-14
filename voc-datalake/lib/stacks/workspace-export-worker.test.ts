/**
 * voc-workspace-export (lib/stacks/workspace-export-worker.ts, VocProcessingStack; docs/multi-workspace.md "Export
 * and delete"): its function settings and its role's exact grants.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { IamPolicySchema, isAttachedToRole, roleStatements, statementActions } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { expectSelfInvokeOnly, findWorkerFunction, workerSettings } from '../test-support/worker-function';
import { byCodeUnit } from '../utils/compare';
import {
  CONTROL_PARTITIONS, EXPORT_JOB_PARTITION, MEMORY_TABLE_PARTITIONS, WORKSPACE_DATE_PARTITIONS,
  WORKSPACE_EXPORT_MAX_EVENT_AGE_MINUTES,
  WORKSPACE_EXPORT_RESERVED_CONCURRENCY,
} from './workspace-export-worker';
import { WORKSPACE_OBJECTS_PREFIX } from './core-buckets';

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

/** One workspace id in an IAM pattern: `ws_` and 26 `?` (lib/stacks/core-buckets.ts WORKSPACE_ID_PATTERN). */
const ONE_WORKSPACE = `ws_${'?'.repeat(26)}`;
const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });

const worker = () => findWorkerFunction(template, 'voc-workspace-export-');
const statements = () => roleStatements(template, worker().Role['Fn::GetAtt'][0]);
/** The role's Allow statements with their conditions (the audit-row guard's Denies left out). */
const allowed = () => Object.values(template.findResources('AWS::IAM::Policy'))
  .map((resource) => IamPolicySchema.parse(resource).Properties)
  .filter((policy) => isAttachedToRole(policy, worker().Role['Fn::GetAtt'][0]))
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow')
  .map((statement) => ({ actions: statementActions(statement), resource: JSON.stringify(statement.Resource),
    condition: statement.Condition }));
const on = (table: string) => allowed()
  .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')) && s.resource.includes(table))
  .map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
  .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));

describe('the voc-workspace-export job', () => {
  it('runs one vCPU for 15 minutes, at most ten at once, no async retry, no event older than 40 minutes', () => {
    expect(worker().Handler).toBe('jobs/workspace_export/handler.lambda_handler');
    const { sizing, invokeConfigs } = workerSettings(template, 'WorkspaceExportWorkerExport');
    expect(sizing).toStrictEqual([1769, 900, WORKSPACE_EXPORT_RESERVED_CONCURRENCY]);
    expect([...invokeConfigs, [WORKSPACE_EXPORT_RESERVED_CONCURRENCY, WORKSPACE_EXPORT_MAX_EVENT_AGE_MINUTES]])
      // 40 minutes of throttling retries plus the 15-minute timeout stay inside the lock's hour.
      .toStrictEqual([[0, WORKSPACE_EXPORT_MAX_EVENT_AGE_MINUTES * 60], [10, 40]]);
  });

  it('is told its tables and bucket, and no secret, parameter or key', () => {
    const variables = worker().Environment.Variables;
    expect(Object.keys(variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'WORKSPACES_TABLE', 'RAW_DATA_BUCKET']));
    for (const name of ['SECRETS_ARN', 'WORKSPACE_PARAMETER_PREFIX', 'KMS_KEY_ARN']) expect(variables).not.toHaveProperty(name);
  });

  it('reads voc-feedback by date only: Query of gsi1-by-date on one workspace\'s days, never the table, never a Scan', () => {
    expect(WORKSPACE_DATE_PARTITIONS).toBe(`WS#${ONE_WORKSPACE}#DATE#*`);
    expect(on('Feedback')).toStrictEqual([{ actions: ['dynamodb:Query'], condition: keys([WORKSPACE_DATE_PARTITIONS]) }]);
    const feedback = allowed().filter((s) => s.resource.includes('Feedback'));
    expect(feedback.map((s) => s.resource)).toStrictEqual([expect.stringContaining('/index/gsi1-by-date')]);
  });

  it('reads one workspace\'s partitions of voc-aggregates and updates only its export jobs and lock', () => {
    expect(on('Aggregates')).toStrictEqual([
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: keys([`WS#${ONE_WORKSPACE}#*`]) },
      { actions: ['dynamodb:UpdateItem'], condition: keys([EXPORT_JOB_PARTITION]) },
    ]);
  });

  it('only Queries voc-workspaces, in a workspace\'s own two control partitions', () => {
    expect(CONTROL_PARTITIONS).toStrictEqual([`WS#${ONE_WORKSPACE}`, `AUDIT#WS#${ONE_WORKSPACE}`]);
    expect(on('Workspaces')).toStrictEqual([{ actions: ['dynamodb:Query'], condition: keys(CONTROL_PARTITIONS) }]);
  });

  it('only Queries voc-memory, in one workspace\'s company memory partitions and its personal counts (4c)', () => {
    expect(MEMORY_TABLE_PARTITIONS).toStrictEqual([`WS#${ONE_WORKSPACE}#MEM#company`, `WS#${ONE_WORKSPACE}#MEMEVT#*`,
      `WS#${ONE_WORKSPACE}#MEMIMPORT`]);
    const memory = allowed().filter((s) => s.actions.some((action) => action.startsWith('dynamodb:'))
      && s.resource.includes('Memory'))
      .map((s) => ({ actions: s.actions, index: s.resource.includes('/index/gsi1-by-memory-status'),
        condition: s.condition }));
    const countOnly = (partition: string) => ({ ...keys([partition]), StringEquals: { 'dynamodb:Select': 'COUNT' } });
    expect(memory).toStrictEqual([
      { actions: ['dynamodb:Query'], index: false, condition: keys(MEMORY_TABLE_PARTITIONS) },
      // The members' sessions and personal memories: a count only, so no statement or owner can be read there.
      { actions: ['dynamodb:Query'], index: false, condition: countOnly(`WS#${ONE_WORKSPACE}#MEMCURSOR`) },
      { actions: ['dynamodb:Query'], index: true, condition: countOnly(`WS#${ONE_WORKSPACE}#MEMSTATUS#personal#*`) },
    ]);
    expect(worker().Environment.Variables).toHaveProperty('MEMORY_TABLE');
  });

  it('holds no Scan, BatchWrite or table delete, and deletes only its own work objects', () => {
    const actions = new Set(allowed().flatMap((s) => s.actions));
    expect([...actions].filter((action) => action.startsWith('dynamodb:')).sort(byCodeUnit))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    expect([...actions].filter((action) => /Delete|Scan|BatchWrite/.test(action))).toStrictEqual(['s3:DeleteObject']);
    const deletes = allowed().filter((s) => s.actions.includes('s3:DeleteObject'));
    expect(deletes.map((s) => [s.actions, [...s.resource.matchAll(/"\/([^"]*)"/g)].map((match) => match[1])]))
      .toStrictEqual([[['s3:DeleteObject'], [`ws/${ONE_WORKSPACE}/exports/*/work/*`]]]);
  });

  it('writes, tags, reads, aborts and lists the parts of objects under one workspace\'s exports only', () => {
    const s3 = allowed().filter((s) => s.actions.includes('s3:PutObject'));
    expect(s3.map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([[
      's3:AbortMultipartUpload', 's3:GetObject', 's3:ListMultipartUploadParts', 's3:PutObject', 's3:PutObjectTagging']]);
    expect(s3[0]?.resource).toContain(`/ws/${ONE_WORKSPACE}/exports/*`);
    expect(s3[0]?.resource).not.toMatch(/\/(raw|silver)\//);
    const writes = allowed().filter((s) => s.actions.some((action) => /^s3:(Put|Abort|Delete)/.test(action)));
    expect(writes.every((s) => s.resource.includes(`/ws/${ONE_WORKSPACE}/exports/`))).toBe(true);
  });

  it('lists and reads one workspace\'s own objects, and nothing else of the bucket (slice 4b)', () => {
    expect(WORKSPACE_OBJECTS_PREFIX).toBe(`ws/${ONE_WORKSPACE}/*`);
    const lists = allowed().filter((s) => s.actions.some((action) => action.startsWith('s3:List')
      && action !== 's3:ListMultipartUploadParts'));
    // The bucket itself (no object path), only with that one workspace's prefix.
    expect(lists.map((s) => ({ actions: s.actions, condition: s.condition, objects: s.resource.includes('/*') })))
      .toStrictEqual([{ actions: ['s3:ListBucket'], objects: false,
        condition: { StringLike: { 's3:prefix': [`ws/${ONE_WORKSPACE}/*`] } } }]);
    const reads = allowed().filter((s) => s.actions.length === 1 && s.actions[0] === 's3:GetObject');
    expect(reads.map((s) => ({ paths: [...s.resource.matchAll(/"\/([^"]*)"/g)].map((match) => match[1]),
      condition: s.condition }))).toStrictEqual([{ paths: [`ws/${ONE_WORKSPACE}/*`], condition: undefined }]);
  });

  it('never reads a credential, and reaches nothing else', () => {
    const services = new Set(allowed().flatMap((s) => s.actions).map((action) => action.split(':')[0]));
    expect([...services].filter((service) => !['dynamodb', 's3', 'kms', 'lambda', 'logs', 'xray']
      .includes(service ?? ''))).toStrictEqual([]);
  });

  it('invokes only itself, by its unqualified name', () => {
    expectSelfInvokeOnly(statements(), 'voc-workspace-export-');
  });
});
