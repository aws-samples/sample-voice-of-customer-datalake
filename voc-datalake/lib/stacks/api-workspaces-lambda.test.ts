/**
 * The workspaces API, `voc-workspaces-api` (lib/stacks/api-workspaces-lambda.ts, docs/multi-workspace.md):
 * GET, POST, PUT and DELETE /me/{proxy+} and GET + POST /platform/{proxy+} behind the Cognito authorizer, a role of
 * its own with exactly the actions its code uses: on the voc-workspaces table Query, GetItem, PutItem in the
 * partitions a create, an add and an audit write, UpdateItem on `WS#*` and `WORKSPACES` (attribute `secret_status`
 * only) and on `WS#*` and `USER#*` (attribute `role` only), DeleteItem on `WS#*` and `USER#*` (a member's removal),
 * ConditionCheckItem on `WS#*`; the live platform-admin check's two Cognito reads plus ListUsers and AdminCreateUser
 * (adding a member); and the per-workspace credentials secrets' create, describe and tag on `voc/ws/*` only.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  actionsWithPrefix, apiMethods, apiTemplate, apiTemplateAllPlugins, functionIdForHandler, nonOptions, policyStatementsOf,
  resolveMethod,
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

  it('names the plugins the deployment offers (cdk.context.json): the ceiling of a workspace\'s plugins', () => {
    // The default fixture enables no plugin; the all-plugins one enables every plugin under plugins/.
    expect(environment().ENABLED_SOURCES).toBe('[]');
    // The one ceiling: the same list the integrations API (and the ingestors' track) is given.
    const all = serviceEnvironment(apiTemplateAllPlugins(), 'voc-workspaces-api').ENABLED_SOURCES;
    expect(all).toStrictEqual(serviceEnvironment(apiTemplateAllPlugins(), 'voc-integrations-api').ENABLED_SOURCES);
    expect(JSON.parse(String(all))).toContain('webscraper');
  }, SYNTH_TIMEOUT_MS);

  it('may Query, GetItem, PutItem, UpdateItem, DeleteItem and ConditionCheckItem on the workspaces table, nothing else', () => {
    expect(actionsWithPrefix(statements(), 'dynamodb:')).toStrictEqual([
      'dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query',
      'dynamodb:UpdateItem']);
  });

  it('reads without a key condition; puts, updates, deletes and checks only in their partitions and attributes', () => {
    const shape = withPrefix('dynamodb:').map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join() + JSON.stringify(a.condition), b.actions.join() + JSON.stringify(b.condition)));
    expect(shape).toStrictEqual([
      { actions: ['dynamodb:ConditionCheckItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] } } },
      // A member's removal: their MEMBER# and USER# rows (IAM pins the partition, not the sort key).
      { actions: ['dynamodb:DeleteItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'PLUGIN#*', 'USER#*', 'WS#*'] } } },
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: undefined },
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'AUDIT#WS#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'] } } },
      // A role change: `role` alone, on the MEMBER# and USER# rows.
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'role', 'sk'] } } },
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WORKSPACES', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'secret_status', 'sk'] } } },
    ]);
  });

  // The fixture's tables all carry an index (api-stack-fixture.ts), so CDK names it in the read grant; the writes
  // name the table alone. voc-workspaces has no index.
  it('names the workspaces table and no other table', () => {
    const resources = withPrefix('dynamodb:').map((s) => s.resource);
    expect(resources).toHaveLength(6);
    expect(resources.join('\n').match(/ExportsOutputFnGetAtt[A-Za-z]+/g)?.sort(byCodeUnit))
      .toStrictEqual(Array<string>(7).fill('ExportsOutputFnGetAttWorkspaces'));
  });

  it('reads the caller\'s groups and account, finds and creates accounts, on the user pool only', () => {
    const cognito = withPrefix('cognito-idp:');
    expect(cognito.map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([[
      'cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:ListUsers']]);
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

// DELETE /users/{username} removes the user's memberships first (lambda/shared/workspace_members.py
// plan_user_removal, remove_user_memberships; lib/stacks/api-engagement-lambdas.ts).
describe('the users API on voc-workspaces (a deleted user\'s memberships)', () => {
  const onWorkspaces = () => policyStatementsOf(apiTemplate(), 'UsersLambdaRole')
    .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')))
    .filter((s) => /ExportsOutputFnGetAttWorkspaces/.test(s.resource));
  const keys = (partitions: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': partitions } });

  it('is told the table', () => {
    expect(JSON.stringify(serviceEnvironment(apiTemplate(), 'voc-users-api').WORKSPACES_TABLE)).toMatch(/Workspaces/);
  });

  it('reads, checks, puts audit rows and deletes membership rows, each pinned to its partitions; no Scan or update', () => {
    const shape = onWorkspaces().map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join(), b.actions.join()));
    expect(shape).toStrictEqual([
      { actions: ['dynamodb:ConditionCheckItem'], condition: keys(['WS#*']) },
      { actions: ['dynamodb:DeleteItem'], condition: keys(['USER#*', 'WS#*']) },
      { actions: ['dynamodb:GetItem'], condition: keys(['AUDIT#WS#*', 'WS#*']) },
      { actions: ['dynamodb:PutItem'], condition: keys(['AUDIT#WS#*']) },
      { actions: ['dynamodb:Query'], condition: keys(['USER#*', 'WS#*']) },
    ]);
  });
});

describe('/me/{proxy+} and /platform/{proxy+}', () => {
  it.each([
    ['GET', '/me/workspaces'], ['GET', '/me/workspaces/current'], ['GET', '/me/workspaces/current/members'],
    ['POST', '/me/workspaces/current/members'], ['PUT', '/me/workspaces/current/members/sub-ana'],
    ['DELETE', '/me/workspaces/current/members/sub-ana'], ['GET', '/platform/workspaces'],
    ['POST', '/platform/workspaces'],
  ])('routes %s %s to the workspaces handler behind Cognito', (verb, path) => {
    const method = resolveMethod(apiMethods(apiTemplate()), verb, path);
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'workspaces_handler.py'));
    expect([method?.authorizationType, method?.hasAuthorizerId]).toStrictEqual(['COGNITO_USER_POOLS', true]);
  });

  it('serves GET, POST, PUT and DELETE on /me and GET + POST on /platform, through their proxies only', () => {
    const routes = nonOptions(apiTemplate())
      .filter((m) => ['/me', '/platform'].some((root) => m.path === root || m.path.startsWith(`${root}/`)))
      .map((m) => m.route).sort(byCodeUnit);
    expect(routes).toStrictEqual([
      'DELETE /me/{proxy+}', 'GET /me/{proxy+}', 'GET /platform/{proxy+}', 'POST /me/{proxy+}',
      'POST /platform/{proxy+}', 'PUT /me/{proxy+}']);
  });
});
