/**
 * The workspaces API's delete routes (lib/stacks/api-workspace-delete.ts, docs/multi-workspace.md "Export and
 * delete"): what its role gains, and where it finds the job. The job itself is VocProcessingStack's
 * (workspace-delete-worker.test.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  apiTemplate, apiTemplateHardDelete, policyStatementsOf, serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { DELETE_STATUS_ATTRIBUTES, ERASURE_JOB_PARTITION, WORKSPACE_META_PARTITION } from './api-workspace-delete';

beforeAll(() => { apiTemplate(); apiTemplateHardDelete(); }, SYNTH_TIMEOUT_MS);

describe('without -c workspaceHardDelete=true (the default)', () => {
  it('grants only what a cancel writes (it restores a workspace), no invoke, and tells the routes the delete is off', () => {
    const off = policyStatementsOf(apiTemplate(), 'WorkspacesLambdaRole')
      .filter((s) => /WSDELETE|workspace-deletes|JOB#erasure|deleting_at|voc-workspace-delete/
        .test(JSON.stringify(s.condition) + s.resource))
      .map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
    const env = serviceEnvironment(apiTemplate(), 'voc-workspaces-api');
    expect({ off, deleteFunction: env.DELETE_FUNCTION, flag: env.WORKSPACE_HARD_DELETE }).toStrictEqual({
      off: [
        { actions: ['dynamodb:PutItem'], condition: keys(['AUDIT#workspace-deletes']) },
        { actions: ['dynamodb:UpdateItem'], condition: {
          ...keys(['WORKSPACES', `WS#ws_${'?'.repeat(26)}`]),
          'ForAllValues:StringEquals': { 'dynamodb:Attributes': DELETE_STATUS_ATTRIBUTES } } },
        { actions: ['dynamodb:UpdateItem'], condition: keys(['WSDELETE']) },
        { actions: ['dynamodb:UpdateItem'], condition: keys([ERASURE_JOB_PARTITION]) },
      ].sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))),
      deleteFunction: undefined, flag: 'false' });
  });
});

/** The workspaces API role's statements (the hard delete on), and its DynamoDB ones on one table in short. */
const routeStatements = () => policyStatementsOf(apiTemplateHardDelete(), 'WorkspacesLambdaRole');
const onTable = (table: RegExp) => routeStatements()
  .filter((s) => table.test(s.resource) && s.actions.some((action) => action.startsWith('dynamodb:')))
  .map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }));
const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });

describe('the workspaces API\'s delete routes', () => {
  it('take, read and free the workspace\'s erasure lock in voc-aggregates, nothing else of it', () => {
    expect(ERASURE_JOB_PARTITION).toBe(`WS#ws_${'?'.repeat(26)}#JOB#erasure`);
    const erasure = onTable(/ExportsOutputFnGetAttAggregates/)
      .filter((s) => JSON.stringify(s.condition).includes('JOB#erasure'))
      .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(erasure).toStrictEqual([
      { actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], condition: keys([ERASURE_JOB_PARTITION]) },
      { actions: ['dynamodb:Query'], condition: keys([ERASURE_JOB_PARTITION]) },
    ]);
  });

  it('move META\'s and the listing row\'s status only, write the job row and the platform\'s audit rows', () => {
    expect(DELETE_STATUS_ATTRIBUTES).toStrictEqual(['deleting_at', 'pk', 'sk', 'status', 'workspace_id']);
    // META's partition is exactly one workspace id: no `WS#{id}#…` data partition is in reach of the status update.
    expect(WORKSPACE_META_PARTITION).toBe(`WS#ws_${'?'.repeat(26)}`);
    const added = onTable(/ExportsOutputFnGetAttWorkspaces/).filter((s) => /WSDELETE|workspace-deletes|deleting_at/
      .test(JSON.stringify(s.condition)));
    const sortedAdded = [...added].sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));
    expect(sortedAdded).toStrictEqual([
      { actions: ['dynamodb:PutItem'], condition: keys(['AUDIT#workspace-deletes']) },
      { actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], condition: keys(['WSDELETE']) },
      { actions: ['dynamodb:UpdateItem'], condition: {
        ...keys(['WORKSPACES', `WS#ws_${'?'.repeat(26)}`]),
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': DELETE_STATUS_ATTRIBUTES } } },
    ].sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b))));
    const deletes = onTable(/ExportsOutputFnGetAttWorkspaces/).filter((s) => s.actions.includes('dynamodb:DeleteItem'));
    expect(deletes.map((s) => s.condition)).toStrictEqual([keys(['USER#*', 'WS#*'])]);
  });

  it('invoke only the delete job by name (beside the export job) and are told its name', () => {
    const invokes = routeStatements().filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokes.map((s) => /function:(voc-workspace-[a-z]+)-/.exec(s.resource)?.[1] ?? '').sort(byCodeUnit))
      .toStrictEqual(['voc-workspace-delete', 'voc-workspace-export']);
    const env = serviceEnvironment(apiTemplateHardDelete(), 'voc-workspaces-api');
    expect(JSON.stringify(env.DELETE_FUNCTION)).toMatch(/voc-workspace-delete-/);
    expect(env.WORKSPACE_HARD_DELETE).toBe('true');
    expect(JSON.stringify(apiTemplateHardDelete().findResources('AWS::Lambda::Function'))).not.toContain('workspace_delete');
  });
});
