/**
 * The workspaces API's export routes (lib/stacks/api-workspace-export.ts, docs/multi-workspace.md "Export and
 * delete"): what its role gains, and where it finds the job. The job itself is VocProcessingStack's
 * (workspace-export-worker.test.ts); the bucket's lifecycle rule and Denies are pinned in core-buckets.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { EXPORT_JOB_PARTITION } from './workspace-export-worker';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** One workspace id in an IAM pattern: `ws_` and 26 `?` (lib/stacks/core-buckets.ts WORKSPACE_ID_PATTERN). */
const ONE_WORKSPACE = `ws_${'?'.repeat(26)}`;
const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });
const routeStatements = () => policyStatementsOf(apiTemplate(), 'WorkspacesLambdaRole');

describe('the workspaces API\'s export routes', () => {
  it('put, update and query only the export jobs partition of voc-aggregates', () => {
    expect(EXPORT_JOB_PARTITION).toBe(`WS#${ONE_WORKSPACE}#JOB#export`);
    const onAggregates = routeStatements()
      .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')))
      .filter((s) => /ExportsOutputFnGetAttAggregates/.test(s.resource))
      .map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(onAggregates).toStrictEqual([
      { actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], condition: keys([EXPORT_JOB_PARTITION]) },
      { actions: ['dynamodb:Query'], condition: keys([EXPORT_JOB_PARTITION]) },
    ]);
  });

  it('read (to sign a download) only under one workspace\'s exports, and invoke only the export job, by name', () => {
    const s3 = routeStatements().filter((s) => s.actions.some((action) => action.startsWith('s3:')));
    expect(s3.map((s) => s.actions)).toStrictEqual([['s3:GetObject']]);
    expect(s3[0]?.resource).toContain(`/ws/${ONE_WORKSPACE}/exports/*`);
    const invokes = routeStatements().filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.resource).toContain('function:voc-workspace-export-');
  });

  it('are told the aggregates table, the bucket and the job; the job is not in this stack', () => {
    const env = serviceEnvironment(apiTemplate(), 'voc-workspaces-api');
    expect(JSON.stringify(env.AGGREGATES_TABLE)).toMatch(/Aggregates/);
    expect(JSON.stringify(env.RAW_DATA_BUCKET)).toMatch(/RawData/);
    expect(JSON.stringify(env.EXPORT_FUNCTION)).toMatch(/voc-workspace-export-/);
    expect(JSON.stringify(apiTemplate().findResources('AWS::Lambda::Function'))).not.toContain('workspace_export');
  });
});
