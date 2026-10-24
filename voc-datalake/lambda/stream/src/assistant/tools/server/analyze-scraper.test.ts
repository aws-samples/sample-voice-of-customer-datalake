/**
 * analyze_scraper_url: an admin-only POST /scrapers/analyze-url as the caller
 * (claims forwarded) that starts an assist job, then polls GET
 * /scrapers/jobs/{id}; the suggestion reaches the model only.
 */
import { InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import { createInternalApiInvoker, SCRAPER_ANALYZE_RESOURCE } from '../internal-api.js';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';

const URL_ARG = { url: 'https://www.acme.example/reviews' };
const ANSWER = {
  success: true,
  selectors: { container_selector: '.review', text_selector: '.body', confidence: 'high', detected_reviews_count: 12, prompt: 'leak' },
};
const STARTED = { success: true, job_id: 'job_1', status: 'pending' };
const COMPLETED = { success: true, job_id: 'job_1', job_type: 'assist_analyze_url', status: 'completed', error: null, result: ANSWER };
const ROUTE = { [`POST ${SCRAPER_ANALYZE_RESOURCE}`]: STARTED, 'GET /scrapers/jobs/job_1': COMPLETED };
const admin = fakeContext('scrapers', {}, { isAdmin: true, claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } });

describe('analyze_scraper_url', () => {
  it('starts the job with the URL, then polls its job route on the scrapers proxy, both as the caller', async () => {
    const deps = fakeDeps(ROUTE);
    await serverTool(deps, 'analyze_scraper_url').execute(URL_ARG, admin);
    expect(deps.calls).toStrictEqual([
      {
        call: { fn: 'scrapers', method: 'POST', path: '/scrapers/analyze-url', resource: '/scrapers/analyze-url', body: URL_ARG },
        sub: 'admin-sub',
      },
      {
        call: { fn: 'scrapers', method: 'GET', path: '/scrapers/jobs/job_1', resource: '/scrapers/{proxy+}', pathParameters: { proxy: 'jobs/job_1' } },
        sub: 'admin-sub',
      },
    ]);
  });

  it('keeps polling while the job is pending or running', async () => {
    const answers = [STARTED, { status: 'pending' }, { status: 'running' }, COMPLETED];
    const deps = fakeDeps({}, { invoke: () => Promise.resolve(answers.shift()) });
    const result = await serverTool(deps, 'analyze_scraper_url').execute(URL_ARG, admin);
    expect(JSON.parse(result.content)).toMatchObject({ selectors: { container_selector: '.review' } });
    expect(answers).toStrictEqual([]);
  });

  it('reports a failed job with its error text', async () => {
    const deps = fakeDeps({ ...ROUTE, 'GET /scrapers/jobs/job_1': { status: 'failed', error: 'Could not fetch the page.', result: null } });
    await expect(serverTool(deps, 'analyze_scraper_url').execute(URL_ARG, admin))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The page analysis failed: Could not fetch the page.' });
  });

  it('does not poll when the run is about to be cut off', async () => {
    const deps = fakeDeps(ROUTE);
    const late = { ...admin, deadlineMs: deps.nowMs() + 30_000 };
    await expect(serverTool(deps, 'analyze_scraper_url').execute(URL_ARG, late))
      .rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('taking too long') });
    expect(deps.calls.map((c) => c.call.method)).toStrictEqual(['POST']);
  });

  it('returns only the selector suggestion, marked as not saved', async () => {
    const result = await serverTool(fakeDeps(ROUTE), 'analyze_scraper_url').execute(URL_ARG, admin);
    expect(JSON.parse(result.content)).toStrictEqual({
      url: URL_ARG.url,
      saved: false,
      selectors: { container_selector: '.review', text_selector: '.body', confidence: 'high', detected_reviews_count: 12 },
    });
  });

  it('refuses a non-admin before any invoke', async () => {
    const deps = fakeDeps(ROUTE);
    await expect(serverTool(deps, 'analyze_scraper_url').execute(URL_ARG, fakeContext('scrapers')))
      .rejects.toMatchObject({ code: 'not_permitted' });
    expect(deps.calls).toStrictEqual([]);
  });

  it.each(['http://www.acme.example/', 'https://169.254.169.254/latest', 'https://localhost/'])('refuses %s before any invoke', async (url) => {
    const deps = fakeDeps(ROUTE);
    await expect(serverTool(deps, 'analyze_scraper_url').execute({ url }, admin)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });
});

describe('the internal invoker allows the analyze POST on the scrapers function only', () => {
  const ok: InvocationResponse = {
    StatusCode: 200,
    Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 202, body: JSON.stringify(STARTED) })),
  };

  function invoker() {
    const sent: InvokeCommand[] = [];
    const invoke = createInternalApiInvoker({
      send: (command) => {
        sent.push(command);
        return Promise.resolve(ok);
      },
    }, { scrapers: 'voc-scrapers-api', settings: 'voc-settings-api' });
    return { invoke, sent };
  }

  it('forwards the caller claims in the proxy event', async () => {
    const { invoke, sent } = invoker();
    await invoke({ fn: 'scrapers', method: 'POST', path: SCRAPER_ANALYZE_RESOURCE, resource: SCRAPER_ANALYZE_RESOURCE, body: URL_ARG },
      { sub: 'admin-sub', 'cognito:groups': 'admins' });
    const raw = sent[0]?.input.Payload;
    const payload: unknown = raw instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(raw)) : null;
    expect(payload).toMatchObject({
      httpMethod: 'POST', path: '/scrapers/analyze-url', requestContext: { authorizer: { claims: { sub: 'admin-sub', 'cognito:groups': 'admins' } } },
    });
  });

  it('refuses the same POST on another function, and a scraper save', async () => {
    const { invoke, sent } = invoker();
    const claims = { sub: 'admin-sub' };
    await expect(invoke({ fn: 'settings', method: 'POST', path: SCRAPER_ANALYZE_RESOURCE, resource: SCRAPER_ANALYZE_RESOURCE }, claims))
      .rejects.toMatchObject({ code: 'not_permitted' });
    await expect(invoke({ fn: 'scrapers', method: 'POST', path: '/scrapers', resource: SCRAPER_ANALYZE_RESOURCE }, claims))
      .rejects.toMatchObject({ code: 'not_permitted' });
    expect(sent).toStrictEqual([]);
  });
});
