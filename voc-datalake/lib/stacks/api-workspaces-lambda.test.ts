/**
 * The workspaces API, `voc-workspaces-api` (lib/stacks/api-workspaces-lambda.ts, docs/multi-workspace.md):
 * GET /me/{proxy+} behind the Cognito authorizer, a role of its own on the voc-workspaces table only, with the
 * three actions its code uses (Query, GetItem, and PutItem for the platform-admin entry's audit row, only in the
 * `AUDIT#WS#*` partitions).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  apiMethods, apiTemplate, functionIdForHandler, nonOptions, policyStatementsOf, resolveMethod, serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const statements = () => policyStatementsOf(apiTemplate(), 'WorkspacesLambdaRole');
const dynamoStatements = () => statements().filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')));

describe('the voc-workspaces-api Lambda', () => {
  it('is told the voc-workspaces table', () => {
    expect(JSON.stringify(serviceEnvironment(apiTemplate(), 'voc-workspaces-api').WORKSPACES_TABLE)).toMatch(/Workspaces/);
  });

  it('may Query, GetItem and PutItem on the workspaces table, and no other DynamoDB action', () => {
    expect(dynamoStatements().flatMap((s) => s.actions).sort(byCodeUnit))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']);
  });

  it('reads without a key condition, and puts only in the entry audit partitions (AUDIT#WS#*)', () => {
    const shape = dynamoStatements().map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(shape).toStrictEqual([
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: undefined },
      { actions: ['dynamodb:PutItem'],
        condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*'] } } },
    ]);
  });

  // The fixture's tables all carry an index (api-stack-fixture.ts), so CDK names it in the read grant; the put
  // names the table alone. voc-workspaces has no index.
  it('names the workspaces table and no other table', () => {
    const resources = dynamoStatements().map((s) => s.resource);
    expect(resources).toHaveLength(2);
    expect(resources.join('\n').match(/ExportsOutputFnGetAtt[A-Za-z]+/g)?.sort(byCodeUnit))
      .toStrictEqual(['ExportsOutputFnGetAttWorkspaces', 'ExportsOutputFnGetAttWorkspaces',
        'ExportsOutputFnGetAttWorkspaces']);
  });

  it('holds only DynamoDB, KMS for the table key, and its log and trace writes', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0]));
    expect([...services].filter((service) => !['dynamodb', 'kms', 'logs', 'xray'].includes(service ?? ''))).toStrictEqual([]);
  });
});

describe('GET /me/{proxy+}', () => {
  it.each(['/me/workspaces', '/me/workspaces/current'])('routes GET %s to the workspaces handler behind Cognito', (path) => {
    const method = resolveMethod(apiMethods(apiTemplate()), 'GET', path);
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'workspaces_handler.py'));
    expect([method?.authorizationType, method?.hasAuthorizerId]).toStrictEqual(['COGNITO_USER_POOLS', true]);
  });

  it('serves GET only, and nothing on the bare /me', () => {
    const routes = nonOptions(apiTemplate()).filter((m) => m.path === '/me' || m.path.startsWith('/me/')).map((m) => m.route);
    expect(routes).toStrictEqual(['GET /me/{proxy+}']);
  });
});
