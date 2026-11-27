/**
 * The workspaces API, `voc-workspaces-api` (lib/stacks/api-workspaces-lambda.ts, docs/multi-workspace.md):
 * GET, POST, PUT and DELETE /me/{proxy+} and GET + POST /platform/{proxy+} behind the Cognito authorizer, a role of
 * its own with exactly the actions its code uses: on the voc-workspaces table Query, GetItem, PutItem in the
 * partitions a create, an add, an audit and a plugin's enable write, UpdateItem on `WS#*` and `USER#*` (attribute
 * `role` only), DeleteItem on `WS#*` and `USER#*` (a member's removal) and `PLUGIN#*` (a plugin disabled),
 * ConditionCheckItem on `WS#*`; the live platform-admin
 * check's two Cognito reads plus ListUsers and AdminCreateUser (adding a member); with `-c emailFrom` only,
 * `ses:SendEmail` from that address (the member notice) and EMAIL_FROM / FRONTEND_URL. No Secrets Manager and no SSM grant
 * (decision 19: a workspace's credentials parameters are made by their first save, not by its creation).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import {
  actionsWithPrefix, apiMethods, apiTemplate, apiTemplateAllPlugins, apiTemplateHardDelete, buildApiStack,
  functionIdForHandler, nonOptions, policyStatementsOf, resolveMethod,
  serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
  apiTemplateHardDelete();
}, SYNTH_TIMEOUT_MS);

// The role with the hard delete on (-c workspaceHardDelete=true): its own grants plus the delete routes'; off, the
// delete routes' are not there (api-workspace-delete.test.ts).
const statements = () => policyStatementsOf(apiTemplateHardDelete(), 'WorkspacesLambdaRole');
const withPrefix = (prefix: string) => statements().filter((s) => s.actions.some((action) => action.startsWith(prefix)));
// The export routes' grants on voc-aggregates (its export jobs only) are pinned in api-workspace-export.test.ts.
const onWorkspaces = () => withPrefix('dynamodb:').filter((s) => /ExportsOutputFnGetAttWorkspaces/.test(s.resource));
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
    const shape = onWorkspaces().map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition }))
      .sort((a, b) => byCodeUnit(a.actions.join() + JSON.stringify(a.condition), b.actions.join() + JSON.stringify(b.condition)));
    expect(shape).toStrictEqual([
      { actions: ['dynamodb:ConditionCheckItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*'] } } },
      // A member's removal: their MEMBER# and USER# rows (IAM pins the partition, not the sort key); a plugin disabled;
      // a renamed workspace's old listing row (7.40.00).
      { actions: ['dynamodb:DeleteItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'PLUGIN#*', 'WORKSPACES', 'USER#*', 'WS#*'] } } },
      { actions: ['dynamodb:GetItem', 'dynamodb:Query'], condition: undefined },
      // A create's rows, an add's rows, the audits, and an enabled plugin's PLUGIN#{plugin} / WS#{ws} row (7.14.00).
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'AUDIT#WS#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'] } } },
      // A role change: `role` alone, on the MEMBER# and USER# rows.
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'role', 'sk'] } } },
      // A rename (7.40.00): `name` alone, on META and the members' USER# rows.
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USER#*', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['name', 'pk', 'sk'] } } },
      // No `secret_status` update any more: a new workspace's META and listing row are written whole at creation.
      // The delete routes' (lib/stacks/api-workspace-delete.ts, pinned in api-workspace-delete.test.ts): the
      // platform's delete audit rows, the job row, and META's and the listing row's status.
      { actions: ['dynamodb:PutItem'], condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        'AUDIT#workspace-deletes'] } } },
      { actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'], condition: { 'ForAllValues:StringLike': {
        'dynamodb:LeadingKeys': ['WSDELETE'] } } },
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WORKSPACES', `WS#ws_${'?'.repeat(26)}`] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['deleting_at', 'pk', 'sk', 'status', 'workspace_id'] } } },
      // A trial (7.71.00, lambda/shared/trials.py): `trial` alone on META and the listing row, nothing returned.
      { actions: ['dynamodb:UpdateItem'], condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WORKSPACES', 'WS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'trial'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } } },
    ].sort((a, b) => byCodeUnit(a.actions.join() + JSON.stringify(a.condition), b.actions.join() + JSON.stringify(b.condition))));
  });

  // The fixture's tables all carry an index (api-stack-fixture.ts), so CDK names it in the read grant; the writes
  // name the table alone. voc-workspaces has no index.
  it('names the workspaces table, and otherwise only voc-aggregates for the export routes', () => {
    const others = withPrefix('dynamodb:').filter((s) => !/ExportsOutputFnGetAttWorkspaces/.test(s.resource));
    expect(others.length > 0 && others.every((s) => /ExportsOutputFnGetAttAggregates/.test(s.resource))).toBe(true);
    const resources = onWorkspaces().map((s) => s.resource);
    // Seven of its own (the trial's since 7.71.00), three of the delete routes'.
    expect(resources).toHaveLength(10);
    expect(resources.join('\n').match(/ExportsOutputFnGetAtt[A-Za-z]+/g)?.sort(byCodeUnit))
      .toStrictEqual(Array<string>(11).fill('ExportsOutputFnGetAttWorkspaces'));
  });

  it('may Query the cost rows only on voc-aggregates (GET /platform/costs), and is told the table', () => {
    const costs = withPrefix('dynamodb:').filter((s) => JSON.stringify(s.condition ?? {}).includes('#COST'));
    expect(costs.map(({ actions, condition }) => ({ actions, condition }))).toStrictEqual([{
      actions: ['dynamodb:Query'],
      condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [
        `WS#ws_${'?'.repeat(26)}#COST`, 'DEPLOYMENT#COST', 'UNATTRIBUTED#COST'] } },
    }]);
    expect(costs[0]?.resource).toMatch(/ExportsOutputFnGetAttAggregates/);
    expect(JSON.stringify(environment().AGGREGATES_TABLE)).toMatch(/Aggregates/);
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

  it('holds only DynamoDB, Cognito, KMS, its log and trace writes, and the export routes\' S3 read and invoke', () => {
    const services = new Set(statements().flatMap((s) => s.actions).map((action) => action.split(':')[0]));
    expect([...services].filter((service) => !['dynamodb', 'cognito-idp', 'kms', 'logs', 'xray', 's3', 'lambda']
      .includes(service ?? ''))).toStrictEqual([]);
  });

  // A trial workspace (7.71.00, lib/stacks/trial-expiry.ts): nothing scheduled, the expiry's hourly tick reads the ends.
  it('schedules nothing and passes no role (a trial\'s end is read by the expiry\'s hourly tick)', () => {
    expect([...withPrefix('scheduler:'), ...withPrefix('iam:')]).toStrictEqual([]);
    expect(Object.keys(environment()).filter((name) => name.startsWith('TRIAL_'))).toStrictEqual([]);
  });

  it('reads a paused trial\'s forms and turns them back on through `enabled` and its stamps alone, in a workspace\'s forms partition', () => {
    const forms = withPrefix('dynamodb:').filter((s) => JSON.stringify(s.condition ?? {}).includes('#FEEDBACK_FORM'));
    const partition = { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`WS#ws_${'?'.repeat(26)}#FEEDBACK_FORM`] } };
    expect(forms.map(({ actions, condition }) => ({ actions, condition }))).toStrictEqual([
      // The publish rules asked again before a form is turned back on (lambda/shared/trial_pause.py publish_problem).
      { actions: ['dynamodb:GetItem'], condition: partition },
      { actions: ['dynamodb:UpdateItem'], condition: {
        ...partition,
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['enabled', 'pk', 'sk', 'updated_at', 'updated_by', 'write_count'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': ['NONE'] } } }]);
    expect(forms.every((s) => /ExportsOutputFnGetAttAggregates/.test(s.resource))).toBe(true);
  });

});

// The notice an existing account gets when it is added to a workspace (lambda/shared/member_notice.py): with
// -c emailFrom only, the participants role's grant (lib/utils/email-sender.ts sesSendStatement) and its sender.
describe('the voc-workspaces-api member notice and -c emailFrom', () => {
  const EMAIL_FROM = 'noreply@voc.example.com';
  let cachedEmail: Template | undefined;
  const withEmail = () => (cachedEmail ??= Template.fromStack(buildApiStack({ emailFrom: EMAIL_FROM })));
  beforeAll(() => {
    withEmail();
  }, SYNTH_TIMEOUT_MS);
  const ses = (template: Template) => policyStatementsOf(template, 'WorkspacesLambdaRole')
    .filter((s) => s.actions.some((action) => action.startsWith('ses:')));
  const env = (template: Template) => serviceEnvironment(template, 'voc-workspaces-api');

  it('cannot send email and is told no sender or link origin without -c emailFrom', () => {
    expect(ses(apiTemplate())).toStrictEqual([]);
    expect(ses(apiTemplateHardDelete())).toStrictEqual([]);
    expect(env(apiTemplate())).not.toHaveProperty('EMAIL_FROM');
    expect(env(apiTemplate())).not.toHaveProperty('FRONTEND_URL');
  });

  it('sends only from the configured address, on its SES identities, with -c emailFrom', () => {
    const [statement, ...others] = ses(withEmail());
    expect([others, statement?.actions]).toStrictEqual([[], ['ses:SendEmail']]);
    const identities = z.array(z.unknown()).parse(JSON.parse(statement?.resource ?? '[]')).map((arn) => JSON.stringify(arn));
    expect(identities.map((arn) => /:ses:us-east-1:111111111111:identity\/([^"]+)"/.exec(arn)?.[1]))
      .toStrictEqual(['voc.example.com', EMAIL_FROM]);
    expect(statement?.condition).toStrictEqual({ StringEquals: { 'ses:FromAddress': EMAIL_FROM } });
    // The very statement the engagement API's role gets (one helper).
    const engagement = policyStatementsOf(withEmail(), 'EngagementLambdaRole')
      .filter((s) => s.actions.some((action) => action.startsWith('ses:')));
    expect(engagement).toStrictEqual([statement]);
  });

  it('is told the sender and the frontend origin of the link with -c emailFrom', () => {
    expect(env(withEmail()).EMAIL_FROM).toBe(EMAIL_FROM);
    // The engagement API's FRONTEND_URL (the unsubscribe page): the same origin.
    expect(env(withEmail()).FRONTEND_URL).toStrictEqual(serviceEnvironment(withEmail(), 'voc-engagement-api').FRONTEND_URL);
    expect(JSON.stringify(env(withEmail()).FRONTEND_URL)).toMatch(/^"https:\/\//);
  });

  it('writes the notice guard row (`WS#{ws}` / `NOTICE#{sub}`) through the PutItem it already has, nothing new', () => {
    const shape = (template: Template) => policyStatementsOf(template, 'WorkspacesLambdaRole')
      .filter((s) => s.actions.some((action) => action.startsWith('dynamodb:')))
      .map((s) => ({ actions: [...s.actions].sort(byCodeUnit), condition: s.condition, resource: s.resource }));
    expect(shape(withEmail())).toStrictEqual(shape(apiTemplate()));
    const puts = shape(withEmail()).filter((s) => s.actions.includes('dynamodb:PutItem')
      && /ExportsOutputFnGetAttWorkspaces/.test(s.resource));
    expect(puts.map((s) => s.condition)).toContainEqual(
      { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['AUDIT#WS#*', 'PLUGIN#*', 'SLUG#*', 'USER#*', 'WORKSPACES', 'WS#*'] } });
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
