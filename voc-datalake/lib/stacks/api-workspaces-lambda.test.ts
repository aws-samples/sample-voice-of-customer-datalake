/**
 * The workspaces API, `voc-workspaces-api` (lib/stacks/api-workspaces-lambda.ts, docs/multi-workspace.md):
 * GET /me/{proxy+} and GET + POST /platform/{proxy+} behind the Cognito authorizer, a role of its own with exactly
 * the actions its code uses: on the voc-workspaces table Query, GetItem, PutItem in the partitions a create and an
 * entry write, UpdateItem on `WS#*`; the live platform-admin check's two Cognito reads; and the per-workspace
 * credentials secrets' create, describe and tag on `voc/ws/*` only.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  actionsWithPrefix, apiMethods, apiTemplate, functionIdForHandler, nonOptions, policyStatementsOf, resolveMethod,
  serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const statements = () => policyStatementsOf(apiTemplate(), 'WorkspacesLambdaRole');
const withPrefix = (prefix: string) => statements().filter((s) => s.actions.some((action) => action.startsWith(prefix)));
const environment = () => serviceEnvironment(apiTemplate(), 'voc-workspaces-api');

describe('the voc-workspaces-api Lambda', () => {
  it('is told the voc-workspaces table, the user pool, the key and the secret prefix', () => {
    const env = environment();
    expect(JSON.stringify(env.WORKSPACES_TABLE)).toMatch(/Workspaces/);
    expect(JSON.stringify(env.USER_POOL_ID)).toMatch(/UserPool/);
    expect(JSON.stringify(env.KMS_KEY_ARN)).toMatch(/Key/);
    expect(env.WORKSPACE_SECRET_PREFIX).toBe('voc/ws');
  });

  it('may Query, GetItem, PutItem and UpdateItem on the workspaces table, and no other DynamoDB action', () => {
    expect(actionsWithPrefix(statements(), 'dynamodb:'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
  });

  it('reads without a key condition, puts only in the create and audit partitions, updates only WS#*', () => {
    const shape = withPrefix('dynamodb:').map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(shape).toStrictEqual([
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: undefined },
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'AUDIT#WS#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'] } } },
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WORKSPACES', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'secret_status', 'sk'] } } },
    ]);
  });

  // The fixture's tables all carry an index (api-stack-fixture.ts), so CDK names it in the read grant; the writes
  // name the table alone. voc-workspaces has no index.
  it('names the workspaces table and no other table', () => {
    const resources = withPrefix('dynamodb:').map((s) => s.resource);
    expect(resources).toHaveLength(3);
    expect(resources.join('\n').match(/ExportsOutputFnGetAtt[A-Za-z]+/g)?.sort(byCodeUnit))
      .toStrictEqual(Array<string>(4).fill('ExportsOutputFnGetAttWorkspaces'));
  });

  it('reads the caller\'s groups and account on the user pool only (the live platform-admin check)', () => {
    const cognito = withPrefix('cognito-idp:');
    expect(cognito.map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([
      ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser']]);
    expect(cognito[0]?.resource).toMatch(/UserPool/);
    expect(cognito[0]?.condition).toBeUndefined();
  });

  it('creates (with the customer-managed key only), describes and tags the voc/ws/* secrets, nothing else', () => {
    const shape = withPrefix('secretsmanager:').map((s) => ({
      actions: [...s.actions].sort(byCodeUnit), resource: s.resource, condition: JSON.stringify(s.condition ?? null),
    })).sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(shape.map((s) => s.actions)).toStrictEqual([
      ['secretsmanager:CreateSecret'], ['secretsmanager:DescribeSecret', 'secretsmanager:TagResource']]);
    for (const statement of shape) expect(statement.resource).toMatch(/:secret:voc\/ws\/\*"/);
    expect(shape.map((s) => s.condition)).toStrictEqual([
      expect.stringMatching(/^\{"StringEquals":\{"secretsmanager:KmsKeyArn":.*Key.*\}\}$/), 'null']);
  });

  it('holds only DynamoDB, Cognito, Secrets Manager, KMS for the table and the secrets, and its log and trace writes', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0]));
    expect([...services].filter((service) => !['dynamodb', 'cognito-idp', 'secretsmanager', 'kms', 'logs', 'xray']
      .includes(service ?? ''))).toStrictEqual([]);
  });
});

describe('GET /me/{proxy+} and /platform/{proxy+}', () => {
  it.each([
    ['GET', '/me/workspaces'], ['GET', '/me/workspaces/current'], ['GET', '/platform/workspaces'],
    ['POST', '/platform/workspaces'],
  ])('routes %s %s to the workspaces handler behind Cognito', (verb, path) => {
    const method = resolveMethod(apiMethods(apiTemplate()), verb, path);
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'workspaces_handler.py'));
    expect([method?.authorizationType, method?.hasAuthorizerId]).toStrictEqual(['COGNITO_USER_POOLS', true]);
  });

  it('serves GET on /me and GET + POST on /platform, through their proxies only', () => {
    const routes = nonOptions(apiTemplate())
      .filter((m) => ['/me', '/platform'].some((root) => m.path === root || m.path.startsWith(`${root}/`)))
      .map((m) => m.route).sort(byCodeUnit);
    expect(routes).toStrictEqual(['GET /me/{proxy+}', 'GET /platform/{proxy+}', 'POST /platform/{proxy+}']);
  });
});
