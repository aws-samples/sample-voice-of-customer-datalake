/**
 * voc-workspace-delete (lib/stacks/workspace-delete-worker.ts, VocProcessingStack; docs/multi-workspace.md "Export
 * and delete"): its function settings and every statement of its role, pinned.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

import { IamPolicySchema, isAttachedToRole, roleStatements, statementActions } from '../test-support/iam-statements';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { expectSelfInvokeOnly, findWorkerFunction, workerSettings } from '../test-support/worker-function';
import { byCodeUnit } from '../utils/compare';
import { WORKSPACE_DELETE_GRANTS, deleteGrants } from '../utils/workspace-delete-grants';
import {
  CONTROL_ROW_DELETES, DELETE_AUDIT_PARTITION, DELETE_JOB_PARTITION, DEPLOYMENT_SETTINGS_PARTITIONS, MEMORY_PARTITIONS,
  TOMBSTONE_PARTITIONS,
  WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES, WORKSPACE_DELETE_RESERVED_CONCURRENCY,
} from './workspace-delete-worker';

let template: Template;
beforeAll(() => {
  template = synthProcessingTemplate({ withIndexes: true, context: { workspaceHardDelete: true } });
});

describe('without -c workspaceHardDelete=true (the default)', () => {
  it('builds no delete job, no role and no grant at all', () => {
    const off = JSON.stringify(synthProcessingTemplate({ withIndexes: true }).toJSON());
    expect([off.includes('voc-workspace-delete'), off.includes('WorkspaceDeleteWorker')]).toStrictEqual([false, false]);
  });
});

/** One workspace id in an IAM pattern: `ws_` and 26 `?` (lib/stacks/core-buckets.ts WORKSPACE_ID_PATTERN). */
const ONE = `ws_${'?'.repeat(26)}`;
const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });

const worker = () => findWorkerFunction(template, 'voc-workspace-delete-');
const statements = () => roleStatements(template, worker().Role['Fn::GetAtt'][0]);
/** The role's Allow statements with their conditions (the audit-row guard's Denies kept apart). */
const policy = (effect: 'Allow' | 'Deny') => Object.values(template.findResources('AWS::IAM::Policy'))
  .map((resource) => IamPolicySchema.parse(resource).Properties)
  .filter((properties) => isAttachedToRole(properties, worker().Role['Fn::GetAtt'][0]))
  .flatMap((properties) => properties.PolicyDocument.Statement)
  .filter((statement) => (statement.Effect ?? 'Allow') === effect)
  .map((statement) => ({ actions: [...statementActions(statement)].sort(byCodeUnit),
    resource: JSON.stringify(statement.Resource), condition: statement.Condition }));
const allowed = () => policy('Allow');
/** The DynamoDB statements on one table (by its fixture id), each `{actions, index, condition}`, sorted. */
const on = (table: string) => allowed()
  .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')) && s.resource.includes(table))
  .map((s) => ({ actions: s.actions, index: /\/index\/([a-z0-9-]+)/.exec(s.resource)?.[1] ?? null,
    condition: s.condition }))
  .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
const sorted = <T>(rows: T[]) => [...rows].sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));

describe('the voc-workspace-delete job', () => {
  it('runs 15 minutes, at most two at once, no async retry, no event older than 40 minutes', () => {
    expect(worker().Handler).toBe('jobs/workspace_delete/handler.lambda_handler');
    expect([WORKSPACE_DELETE_RESERVED_CONCURRENCY, WORKSPACE_DELETE_MAX_EVENT_AGE_MINUTES]).toStrictEqual([2, 40]);
    expect(workerSettings(template, 'WorkspaceDeleteWorkerDelete')).toStrictEqual({
      sizing: [1024, 900, 2], invokeConfigs: [[0, 2400]] });
  });

  it('is told its tables, bucket, credentials path and plugins, and no secret or key', () => {
    const variables = worker().Environment.Variables;
    expect(Object.keys(variables)).toStrictEqual(expect.arrayContaining([
      'FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'WORKSPACES_TABLE', 'MEMORY_TABLE', 'WATERMARKS_TABLE', 'RAW_DATA_BUCKET',
      'WORKSPACE_PARAMETER_PREFIX', 'PLUGIN_IDS']));
    expect([variables.WORKSPACE_PARAMETER_PREFIX, variables.WORKSPACE_HARD_DELETE]).toStrictEqual(['/voc/ws', 'true']);
    expect(JSON.parse(String(variables.PLUGIN_IDS))).toStrictEqual(expect.arrayContaining(['webscraper']));
    for (const name of ['SECRETS_ARN', 'KMS_KEY_ARN', 'WORKSPACE_PARAMETER_KEY_ARN']) expect(variables).not.toHaveProperty(name);
  });

  it('every sweep names its grants, and the job holds exactly their union', () => {
    expect(Object.keys(WORKSPACE_DELETE_GRANTS)).toStrictEqual([
      'credentials', 'feedback', 'counters', 'source_runs', 'failures', 'circuits', 'logs', 'scraper_runs',
      'plugin_configs', 'feedback_forms', 'import_runs', 'erasure_jobs', 'watermarks', 'memory', 'exports',
      'objects', 'control_rows']);
    expect([...deleteGrants()].sort(byCodeUnit)).toStrictEqual(['aggregates', 'controlRows', 'credentials',
      'deploymentSettings', 'exportJobs', 'feedback', 'memory', 'metricTypeIndex', 'objects', 'tombstones',
      'watermarks']);
  });

  it('voc-feedback: Query of one workspace\'s days and source partitions, BatchWriteItem on those only', () => {
    expect(on('Feedback')).toStrictEqual(sorted([
      { actions: ['dynamodb:BatchWriteItem'], index: null, condition: keys([`WS#${ONE}#SOURCE#*`]) },
      { actions: ['dynamodb:Query'], index: null, condition: keys([`WS#${ONE}#SOURCE#*`]) },
      { actions: ['dynamodb:Query'], index: 'gsi1-by-date', condition: keys([`WS#${ONE}#DATE#*`]) },
    ]));
  });

  it('voc-aggregates: reads and batch deletes of one workspace, its tombstones and its export rows\' mark only', () => {
    expect(TOMBSTONE_PARTITIONS).toBe('AUDIT#tombstone#*');
    // The deployment's two settings rows, GetItem only: the closed counter families' names (no workspace data).
    expect(DEPLOYMENT_SETTINGS_PARTITIONS).toStrictEqual(['SETTINGS#categories', 'SETTINGS#dimensions']);
    expect(on('Aggregates')).toStrictEqual(sorted([
      { actions: ['dynamodb:GetItem'], index: null, condition: keys(['SETTINGS#categories', 'SETTINGS#dimensions']) },
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], index: null, condition: keys([`WS#${ONE}#*`]) },
      { actions: ['dynamodb:BatchWriteItem'], index: null, condition: keys([`WS#${ONE}#*`]) },
      { actions: ['dynamodb:PutItem'], index: null, condition: keys(['AUDIT#tombstone#*']) },
      { actions: ['dynamodb:UpdateItem'], index: null, condition: keys([`WS#${ONE}#JOB#export`]) },
      { actions: ['dynamodb:Query'], index: 'gsi1-by-metric-type', condition: keys([`WS#${ONE}#*`]) },
    ]));
  });

  it('voc-memory: Query of one workspace\'s partitions and personal status partitions, BatchWriteItem there', () => {
    expect(MEMORY_PARTITIONS).toStrictEqual([`WS#${ONE}#MEM#company`, `WS#${ONE}#MEMCURSOR`, `WS#${ONE}#MEMIMPORT`,
      `WS#${ONE}#MEMEVT#*`]);
    expect(on('Memory')).toStrictEqual(sorted([
      { actions: ['dynamodb:BatchWriteItem'], index: null, condition: keys([`WS#${ONE}#*`]) },
      { actions: ['dynamodb:Query'], index: null, condition: keys(MEMORY_PARTITIONS) },
      { actions: ['dynamodb:Query'], index: 'gsi1-by-memory-status', condition: keys([`WS#${ONE}#MEMSTATUS#personal#*`]) },
    ]));
  });

  it('voc-watermarks: BatchWriteItem of one workspace\'s watermarks only, no read', () => {
    expect(on('Watermarks')).toStrictEqual([
      { actions: ['dynamodb:BatchWriteItem'], index: null, condition: keys([`WS#${ONE}#*`]) }]);
  });

  it('voc-workspaces: its job row, its audit partition, and the workspace\'s control rows by their partitions', () => {
    expect(CONTROL_ROW_DELETES).toStrictEqual([`WS#${ONE}`, 'FORM#*', 'PLUGIN#*', 'USER#*', 'WORKSPACES']);
    expect(on('Workspaces')).toStrictEqual(sorted([
      { actions: ['dynamodb:DeleteItem'], index: null, condition: keys(CONTROL_ROW_DELETES) },
      { actions: ['dynamodb:GetItem'], index: null, condition: keys([DELETE_AUDIT_PARTITION]) },
      { actions: ['dynamodb:PutItem'], index: null, condition: keys([DELETE_AUDIT_PARTITION]) },
      { actions: ['dynamodb:Query'], index: null, condition: keys([`WS#${ONE}`]) },
      { actions: ['dynamodb:UpdateItem'], index: null, condition: keys([DELETE_JOB_PARTITION]) },
      { actions: ['dynamodb:UpdateItem'], index: null, condition: {
        ...keys(['SLUG#*']),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['deleted_at', 'pk', 'sk', 'workspace_id'] } } },
    ]));
  });

  it('holds no Scan, no table delete and no PutItem but on the audit partitions', () => {
    const actions = new Set(allowed().flatMap((s) => s.actions));
    expect([...actions].filter((action) => /Scan|DeleteTable|PartiQL/.test(action))).toStrictEqual([]);
    const puts = allowed().filter((s) => s.actions.includes('dynamodb:PutItem'));
    expect(puts.map((s) => s.condition)).toStrictEqual(expect.arrayContaining([
      keys(['AUDIT#tombstone#*']), keys([DELETE_AUDIT_PARTITION])]));
    expect(puts).toHaveLength(2);
    const batches = allowed().filter((s) => s.actions.includes('dynamodb:BatchWriteItem'));
    expect(batches.every((s) => JSON.stringify(s.condition).includes(`WS#${ONE}#`))).toBe(true);
  });

  it('S3: lists one workspace\'s versions, deletes them by version id and aborts its uploads, nothing else', () => {
    const s3 = allowed().filter((s) => s.actions.some((action) => action.startsWith('s3:')))
      .map((s) => ({ actions: s.actions, paths: [...s.resource.matchAll(/"\/([^"]*)"/g)].map((match) => match[1]),
        condition: s.condition }));
    expect(sorted(s3)).toStrictEqual(sorted([
      { actions: ['s3:ListBucketVersions'], paths: [], condition: { StringLike: { 's3:prefix': [`ws/${ONE}/*`] } } },
      { actions: ['s3:ListBucketMultipartUploads'], paths: [], condition: undefined },
      { actions: ['s3:AbortMultipartUpload', 's3:DeleteObjectVersion'], paths: [`ws/${ONE}/*`], condition: undefined },
    ]));
  });

  it('SSM: lists one workspace\'s credentials path and deletes its parameters, with no decrypt through SSM', () => {
    const ssm = allowed().filter((s) => s.actions.some((action) => action.startsWith('ssm:')));
    expect(ssm.map((s) => s.actions)).toStrictEqual([['ssm:GetParametersByPath'], ['ssm:DeleteParameters']]);
    expect(ssm[0]?.resource).toContain(`voc/ws/${ONE}/credentials"`);
    expect(ssm[1]?.resource).toContain(`voc/ws/${ONE}/credentials/*"`);
    const viaSsm = allowed().filter((s) => JSON.stringify(s.condition ?? {}).includes('"ssm.'));
    expect(viaSsm).toStrictEqual([]);
  });

  it('denies kms:Decrypt through SSM outright (the KMS grant on the tables\' key would otherwise allow it)', () => {
    expect(policy('Deny').filter((s) => s.actions.includes('kms:Decrypt'))).toStrictEqual([{
      actions: ['kms:Decrypt'], resource: '"*"',
      condition: { StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' } } }]);
  });

  it('never reads a secret, and reaches nothing else', () => {
    const services = new Set(allowed().flatMap((s) => s.actions).map((action) => action.split(':')[0] ?? ''));
    expect([...services].sort(byCodeUnit)).toStrictEqual(['dynamodb', 'kms', 'lambda', 'logs', 's3', 'ssm']);
    expect(allowed().flatMap((s) => s.actions).filter((action) => /GetParameter$|GetSecretValue/.test(action)))
      .toStrictEqual([]);
  });

  it('is an audit writer of its tombstones and its completed rows only (the audit-row guard)', () => {
    const denies = policy('Deny').map((s) => JSON.stringify(s.condition));
    expect(denies.some((condition) => condition.includes('AUDIT#tombstone#*'))).toBe(true);
    expect(denies.some((condition) => condition.includes(DELETE_AUDIT_PARTITION))).toBe(true);
  });

  it('invokes only itself, by its unqualified name', () => {
    expectSelfInvokeOnly(statements(), 'voc-workspace-delete-');
  });
});
