/**
 * A standalone prototype is sandboxed to an opaque origin (lib/utils/prototype-csp.ts),
 * so its pin widget's direct POST to `/feedback-forms/{form_id}/submit` sends
 * `Origin: null`, with no credentials. Its preflight is answered by API Gateway's
 * MOCK (never compute — pinned in api-stack-feedback-forms.test.ts), and that mock
 * must keep answering in a way a credential-less `Origin: null` preflight passes:
 * `Access-Control-Allow-Origin: *`, no `Access-Control-Allow-Credentials`, POST and
 * Content-Type allowed. The POST answer itself (`null` for a prototype_pin form only)
 * is the Lambda's: lambda/shared/null_origin_cors.py, lambda/api/test/test_prototype_pins.py.
 *
 * And it is the SAME mock every other route gets: no route's CORS changed for this.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { apiMethods, apiTemplate } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** Each OPTIONS method's path, integration type and the CORS headers its mock answers with. */
function preflights(): { path: string; type: string | undefined; headers: Record<string, string> }[] {
  return apiMethods(apiTemplate())
    .filter((method) => method.httpMethod === 'OPTIONS')
    .map((method) => ({ path: method.path, type: method.integrationType, headers: method.integrationResponseHeaders }));
}

describe('the pin submit preflight from an opaque origin', () => {
  const SUBMIT = '/feedback-forms/{form_id}/submit';

  it('is answered by the gateway mock with a wildcard origin and no credentials', () => {
    const submit = preflights().find((preflight) => preflight.path === SUBMIT);
    expect({
      type: submit?.type,
      origin: submit?.headers['access-control-allow-origin'],
      credentials: submit?.headers['access-control-allow-credentials'],
      allowsPost: submit?.headers['access-control-allow-methods']?.split(',').includes('POST'),
      allowsContentType: submit?.headers['access-control-allow-headers']?.split(',').includes('Content-Type'),
    }).toStrictEqual({ type: 'MOCK', origin: '*', credentials: undefined, allowsPost: true, allowsContentType: true });
  });

  it('is the same preflight every other route gets', () => {
    const all = preflights();
    const submit = all.find((preflight) => preflight.path === SUBMIT);
    const differing = all.filter((preflight) => JSON.stringify(preflight.headers) !== JSON.stringify(submit?.headers));
    expect(all.length).toBeGreaterThan(1);
    expect(differing.map((preflight) => preflight.path)).toStrictEqual([]);
  });
});
