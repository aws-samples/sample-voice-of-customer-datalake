/**
 * `GET /metrics/release-watch` (docs/decisions-and-release-watch.md) is a Cognito-authorized,
 * read-only route of the metrics Lambda. Since 5.47.00 it is served by `/metrics/{proxy+}` (the same
 * Lambda) rather than an explicit resource beside it, which cost three CloudFormation resources.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiMethods, apiTemplate, functionIdForHandler, resolveMethod } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('release watch route', () => {
  it('is routed to the metrics Lambda behind Cognito through the /metrics proxy', () => {
    const template = apiTemplate();
    const method = resolveMethod(apiMethods(template), 'GET', '/metrics/release-watch');
    expect(method?.route).toBe('ANY /metrics/{proxy+}');
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
    expect(method?.hasAuthorizerId).toBe(true);
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(template, 'metrics_handler.py'));
  });

  it('has no explicit resource of its own any more', () => {
    expect(apiMethods(apiTemplate()).filter((m) => m.path === '/metrics/release-watch')).toStrictEqual([]);
  });
});
