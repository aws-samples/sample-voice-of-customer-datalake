/**
 * `GET /metrics/release-watch` (docs/decisions-and-release-watch.md) is an explicit,
 * Cognito-authorized, read-only route on the metrics Lambda — never a write and
 * never served by another domain's Lambda.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { apiMethods, apiTemplate, functionIdForHandler, resolveMethod } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('release watch route', () => {
  it('is its own GET resource, routed to the metrics Lambda behind Cognito', () => {
    const template = apiTemplate();
    const method = resolveMethod(apiMethods(template), 'GET', '/metrics/release-watch');
    expect(method?.path).toBe('/metrics/release-watch');
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(template, 'metrics_handler.py'));
  });

  it('declares no write method on the resource', () => {
    const verbs = apiMethods(apiTemplate())
      .filter((m) => m.path === '/metrics/release-watch')
      .map((m) => m.httpMethod)
      .sort(byCodeUnit);
    expect(verbs).toStrictEqual(['GET', 'OPTIONS']);
  });
});
