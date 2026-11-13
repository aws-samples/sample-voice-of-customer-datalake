/**
 * The workspaces API, `voc-workspaces-api` (lib/stacks/api-workspaces-lambda.ts, docs/multi-workspace.md):
 * GET, POST, PUT and DELETE /me/{proxy+} and GET + POST /platform/{proxy+} behind the Cognito authorizer, a role of
 * its own with exactly the actions its code uses: on the voc-workspaces table Query, GetItem, PutItem in the
 * partitions a create, an add, an audit and a plugin's enable write, UpdateItem on `WS#*` and `USER#*` (attribute
 * `role` only), DeleteItem on `WS#*` and `USER#*` (a member's removal) and `PLUGIN#*` (a plugin disabled),
 * ConditionCheckItem on `WS#*`; the live platform-admin
 * check's two Cognito reads plus ListUsers and AdminCreateUser (adding a member). No Secrets Manager and no SSM grant
 * (decision 19: a workspace's credentials parameters are made by their first save, not by its creation).
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
  it('is told the voc-workspaces table and the user pool, and no secret or parameter prefix or key', () => {
    const env = environment();
    expect(JSON.stringify(env.WORKSPACES_TABLE)).toMatch(/Workspaces/);
    expect(JSON.stringify(env.USER_POOL_ID)).toMatch(/UserPool/);
    for (const name of ['KMS_KEY_ARN', 'WORKSPACE_SECRET_PREFIX', 'WORKSPACE_PARAMETER_PREFIX', 'WORKSPACE_PARAMETER_KEY_ARN']) {
      expect(env).not.toHaveProperty(name);
    }
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
      // A member's removal: their MEMBER# and USER# rows (IAM pins the partition, not the sort key); a plugin disabled.
      { actions: ['dynamodb:DeleteItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'PLUGIN#*', 'USER#*', 'WS#*'] } } },
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: undefined },
      // A create's rows, an add's rows, the audits, and an enabled plugin's PLUGIN#{plugin} / WS#{ws} row (7.14.00).
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'AUDIT#WS#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'] } } },
      // A role change: `role` alone, on the MEMBER# and USER# rows.
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'role', 'sk'] } } },
      // No `secret_status` update any more: a new workspace's META and listing row are written whole at creation.
    ]);
  });

  // The fixture's tables all carry an index (api-stack-fixture.ts), so CDK names it in the read grant; the writes
  // name the table alone. voc-workspaces has no index.
  it('names the workspaces table and no other table', () => {
    const resources = withPrefix('dynamodb:').map((s) => s.resource);
    expect(resources).toHaveLength(5);
    expect(resources.join('\n').match(/ExportsOutputFnGetAtt[A-Za-z]+/g)?.sort(byCodeUnit))
      .toStrictEqual(Array<string>(6).fill('ExportsOutputFnGetAttWorkspaces'));
  });

  it('reads the caller\'s groups and account, finds and creates accounts, on the user pool only', () => {
    const cognito = withPrefix('cognito-idp:');
    expect(cognito.map((s) => [...s.actions].sort(byCodeUnit))).toStrictEqual([[
      'cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:ListUsers']]);
    expect(cognito[0]?.resource).toMatch(/UserPool/);
    expect(cognito[0]?.condition).toBeUndefined();
  });

  it('creates, reads or tags no secret and no parameter (decision 19)', () => {
    expect(withPrefix('secretsmanager:')).toStrictEqual([]);
    expect(withPrefix('ssm:')).toStrictEqual([]);
    expect(JSON.stringify(statements())).not.toMatch(/voc\/ws/);
  });

  it('holds only DynamoDB, Cognito, KMS for the table, and its log and trace writes', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0]));
    expect([...services].filter((service) => !['dynamodb', 'cognito-idp', 'kms', 'logs', 'xray']
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
