/**
 * Feedback Forms schema version 2 (7.04.00, docs/feedback-forms.md): its signed-in routes, and least privilege for the
 * forms Lambda's role.
 *
 * - One form is GET on the item. The results, responses (and the test responses' delete) and test link ride ONE
 *   Cognito proxy under `/feedback-forms/{form_id}` serving only GET, POST and DELETE: every method
 *   Cognito-authorized, never ANY (api-routes.ts). The three public routes are unchanged.
 * - The AI draft (`POST /feedback-forms/draft`, `GET /feedback-forms/draft/{job_id}`) is the SETTINGS Lambda's, on a
 *   static `draft` resource: its role owns the job rows, its assist twin and the Bedrock grant.
 * - The forms role serves the three unauthenticated routes, so it holds NO lambda:InvokeFunction, NO action on the
 *   jobs table and no model grant (TENETS.md tenet 6; the AI review's round 1), and its environment names neither.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { claudeRoleGrantOf } from '../test-support/bedrock-grants';
import { IamPolicySchema, isAttachedToRole, roleStatements } from '../test-support/iam-statements';
import {
  LambdaEnvSchema, apiMethods, apiTemplate, functionIdForHandler, resolveMethod,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const ROLE = 'FeedbackFormLambdaRole';
const FORMS_HANDLER = 'feedback_form_handler.py';
const SETTINGS_HANDLER = 'settings_handler.py';

function formEnv(): Record<string, unknown> {
  const fn = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
    .map((resource) => LambdaEnvSchema.parse(resource).Properties)
    .find((props) => props.Handler === 'feedback_form_handler.lambda_handler'
      && JSON.stringify(props).includes('voc-feedback-form-api'));
  expect(fn, 'the feedback form API Lambda').toBeDefined();
  return fn?.Environment?.Variables ?? {};
}

function roleLogicalId(prefix: string): string {
  const ids = Object.keys(apiTemplate().findResources('AWS::IAM::Role')).filter((id) => id.startsWith(prefix));
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

describe('the schema version 2 routes', () => {
  it.each([
    ['GET', '/feedback-forms/{form_id}', FORMS_HANDLER],
    ['GET', '/feedback-forms/{form_id}/results', FORMS_HANDLER],
    ['GET', '/feedback-forms/{form_id}/responses', FORMS_HANDLER],
    ['DELETE', '/feedback-forms/{form_id}/responses', FORMS_HANDLER],
    ['POST', '/feedback-forms/{form_id}/test-link', FORMS_HANDLER],
    ['POST', '/feedback-forms/draft', SETTINGS_HANDLER],
    ['GET', '/feedback-forms/draft/job_0123456789abcdef', SETTINGS_HANDLER],
  ])('%s %s reaches %s behind Cognito', (verb, path, handlerFile) => {
    const method = resolveMethod(apiMethods(apiTemplate()), verb, path);
    expect(method, `${verb} ${path} is not wired`).toBeDefined();
    expect({ auth: method?.authorizationType, authorizer: method?.hasAuthorizerId, verb: method?.httpMethod })
      .toStrictEqual({ auth: 'COGNITO_USER_POOLS', authorizer: true, verb });
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), handlerFile));
  });

  it('serves the AI draft on a static resource beside the item, POST and GET only', () => {
    const draft = apiMethods(apiTemplate()).filter((m) => m.path.startsWith('/feedback-forms/draft'))
      .map((m) => m.route).sort(byCodeUnit);
    expect(draft).toStrictEqual(['GET /feedback-forms/draft/{job_id}', 'OPTIONS /feedback-forms/draft',
      'OPTIONS /feedback-forms/draft/{job_id}', 'POST /feedback-forms/draft']);
    // The item no longer takes a POST (it only started a draft).
    expect(apiMethods(apiTemplate()).filter((m) => m.path === '/feedback-forms/{form_id}').map((m) => m.httpMethod)
      .sort(byCodeUnit)).toStrictEqual(['DELETE', 'GET', 'OPTIONS', 'PUT']);
  });

  it('serves only GET, POST and DELETE under the item (no ANY, no PUT, no PATCH)', () => {
    const proxied = apiMethods(apiTemplate()).filter((m) => m.path === '/feedback-forms/{form_id}/{proxy+}')
      .map((m) => m.httpMethod).sort(byCodeUnit);
    expect(proxied).toStrictEqual(['DELETE', 'GET', 'OPTIONS', 'POST']);
  });

  it('keeps the public routes to the widget\'s four: the three as they were, and the beacons\' own', () => {
    const open = apiMethods(apiTemplate())
      .filter((m) => m.path.startsWith('/feedback-forms') && m.httpMethod !== 'OPTIONS' && m.authorizationType === 'NONE')
      .map((m) => `${m.httpMethod} ${m.path}`).sort(byCodeUnit);
    expect(open).toStrictEqual(['GET /feedback-forms/{form_id}/config', 'GET /feedback-forms/{form_id}/iframe',
      'POST /feedback-forms/{form_id}/events', 'POST /feedback-forms/{form_id}/submit']);
  });

  it('serves the beacons on the forms Lambda, apart from the submit (its own method, model and throttle)', () => {
    const events = resolveMethod(apiMethods(apiTemplate()), 'POST', '/feedback-forms/f1/events');
    const submit = resolveMethod(apiMethods(apiTemplate()), 'POST', '/feedback-forms/f1/submit');
    expect(events?.path).toBe('/feedback-forms/{form_id}/events');
    expect([events?.integrationFunctionId, submit?.integrationFunctionId])
      .toStrictEqual(Array(2).fill(functionIdForHandler(apiTemplate(), FORMS_HANDLER)));
    expect(events?.logicalId).not.toBe(submit?.logicalId);
  });
});

describe('the forms role, which serves the public routes, holds no AI and no job access', () => {
  const statements = () => roleStatements(apiTemplate(), roleLogicalId(ROLE));
  const policies = () => Object.values(apiTemplate().findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((policy) => isAttachedToRole(policy, roleLogicalId(ROLE)));

  it('may invoke no function', () => {
    expect(statements().filter((s) => s.actions.some((a) => a.startsWith('lambda:')))).toStrictEqual([]);
  });

  it('holds no statement on the jobs table, Allow or Deny', () => {
    const onJobs = policies().flatMap((policy) => policy.PolicyDocument.Statement)
      .filter((statement) => /Jobs/.test(JSON.stringify(statement.Resource)));
    expect(onJobs).toStrictEqual([]);
  });

  it('holds no model grant (the settings role does)', () => {
    // roleStatements reads the role's inline policy AND the customer-managed ones attached to it.
    expect(statements().flatMap((s) => s.actions).filter((a) => a.startsWith('bedrock:'))).toStrictEqual([]);
    expect(() => claudeRoleGrantOf('Api', apiTemplate().toJSON(), ROLE)).toThrow(/found 0/);
    expect(() => claudeRoleGrantOf('Api', apiTemplate().toJSON(), 'SettingsLambdaRole')).not.toThrow();
  });

  it('names no jobs table and no worker in its environment, and keeps the primary language', () => {
    const env = formEnv();
    expect(Object.keys(env).filter((name) => /JOBS|WORKER|ASSIST/.test(name))).toStrictEqual([]);
    // The fixture passes no primaryLanguage: the CDK's own default, as bin/voc-datalake.ts and the processor have it.
    expect(env.PRIMARY_LANGUAGE).toBe('en');
  });

  it('the settings role, which serves the draft, already holds the job rows and its twin', () => {
    const settings = roleStatements(apiTemplate(), roleLogicalId('SettingsLambdaRole'));
    expect(settings.some((s) => /Jobs/.test(s.resource) && s.actions.includes('dynamodb:PutItem'))).toBe(true);
    expect(settings.some((s) => s.actions.includes('lambda:InvokeFunction')
      && s.resource.includes(':function:voc-settings-assist-'))).toBe(true);
  });
});
