/**
 * `GET /projects?ids=…` (the Prioritization board's one-call detail read) rides the
 * EXPLICITLY wired `GET /projects` method — no new resource, no `{proxy+}` — so it
 * costs VocApiStack nothing against the 500-resource ceiling and keeps the Cognito
 * authorizer of the list route.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiMethods, apiTemplate, functionIdForHandler, readRepoFile, resolveMethod } from '../test-support/api-stack-template';
import { pythonIntConstant } from '../test-support/cross-language-invariants';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('batch project detail read', () => {
  it('is served by the explicit, Cognito-authorized GET /projects of the projects Lambda', () => {
    const method = resolveMethod(apiMethods(apiTemplate()), 'GET', '/projects');
    expect(method).toMatchObject({
      httpMethod: 'GET',
      path: '/projects',
      authorizationType: 'COGNITO_USER_POOLS',
      hasAuthorizerId: true,
      integrationFunctionId: functionIdForHandler(apiTemplate(), 'projects_handler.py'),
    });
  });

  it('is the ids branch of that route in the handler, not a route of its own', () => {
    const handler = readRepoFile('lambda', 'api', 'projects_handler.py');
    expect(handler).toMatch(/@app\.get\("\/projects"\)\n@tracer\.capture_method\ndef api_list_projects\(\):/);
    expect(handler).toContain("if 'ids' in params:");
    expect(handler).not.toMatch(/@app\.get\("\/projects\/(batch|details)/);
  });

  it('caps the ids per request at ONE number on the handler, the SPA, the mock and the e2e spec', () => {
    const cap = pythonIntConstant('MAX_PROJECT_DETAIL_BATCH', 'lambda', 'api', 'projects.py');
    const spa = /^export const MAX_PROJECT_DETAIL_BATCH = (\d+)$/m.exec(readRepoFile('frontend', 'src', 'api', 'projectsApi.ts'))?.[1];
    const mock = /^const MOCK_MAX_PROJECT_DETAIL_BATCH = (\d+);$/m.exec(readRepoFile('frontend', 'mock-server.js'))?.[1];
    const e2e = /^const MAX_IDS_PER_BATCH = (\d+)$/m.exec(
      readRepoFile('frontend', 'e2e', 'tests', 'prioritization-requests.spec.ts'))?.[1];
    expect([Number(spa), Number(mock), Number(e2e)]).toStrictEqual([cap, cap, cap]);
  });
});
