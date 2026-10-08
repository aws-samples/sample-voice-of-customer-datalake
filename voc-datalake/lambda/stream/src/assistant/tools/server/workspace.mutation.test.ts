/**
 * Mutation-hardening suite for `workspace.ts`. The catalogue suites only ran
 * `list_scrapers`, so a run found every other forms/prioritization/scrapers/
 * settings tool unexecuted: the API call each one makes (function, path with
 * the encoded id, resource template, path parameters, the submissions limit
 * and its bounds), the result shape, the strict no-argument inputs, the specs
 * the model reads, and the pack each tool belongs to. Each case pins the exact
 * call and the exact content.
 */
import { describe, expect, it } from 'vitest';
import type { ApiCall } from '../internal-api.js';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { createWorkspaceServerTools } from './workspace.js';

/** An id the charset allows but a path segment must encode (`:` → `%3A`). */
const ID = 'a:1';

/** The input schema of a tool that takes no argument. */
const NO_ARGUMENTS = { type: 'object', properties: {}, required: [], additionalProperties: false };

/** Run `name` against one route answering `body`; the recorded call and the result. */
async function runTool(name: string, route: string, body: unknown, input: unknown = {}) {
  const deps = fakeDeps({ [route]: body });
  const result = await serverTool(deps, name).execute(input, fakeContext());
  const calls: ApiCall[] = deps.calls.map((entry) => entry.call);
  return { calls, result, subs: deps.calls.map((entry) => entry.sub) };
}

describe('the workspace tool set', () => {
  it('lists the tools in pack order with their packs and required arguments', () => {
    const tools = createWorkspaceServerTools(fakeDeps());
    expect(tools.map((tool) => [tool.kind, tool.name, tool.pack, tool.spec.toolSpec?.name, tool.spec.toolSpec?.inputSchema?.json])).toStrictEqual([
      ['server', 'list_feedback_forms', 'forms', 'list_feedback_forms', NO_ARGUMENTS],
      ['server', 'get_feedback_form_stats', 'forms', 'get_feedback_form_stats', {
        type: 'object', properties: { form_id: { type: 'string', maxLength: 128, description: 'Feedback form id.' } }, required: ['form_id'], additionalProperties: false,
      }],
      ['server', 'get_feedback_form_submissions', 'forms', 'get_feedback_form_submissions', {
        type: 'object',
        properties: {
          form_id: { type: 'string', maxLength: 128, description: 'Feedback form id.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max submissions (default 20).' },
        },
        required: ['form_id'],
        additionalProperties: false,
      }],
      ['server', 'get_prioritization', 'prioritization', 'get_prioritization', NO_ARGUMENTS],
      ['server', 'list_scrapers', 'scrapers', 'list_scrapers', NO_ARGUMENTS],
      ['server', 'get_scraper_status', 'scrapers', 'get_scraper_status', {
        type: 'object', properties: { scraper_id: { type: 'string', maxLength: 128, description: 'Scraper id.' } }, required: ['scraper_id'], additionalProperties: false,
      }],
      ['server', 'get_categories_config', 'settings', 'get_categories_config', NO_ARGUMENTS],
      ['server', 'get_brand_settings', 'settings', 'get_brand_settings', NO_ARGUMENTS],
    ]);
  });

  it('describes each tool to the model', () => {
    const tools = createWorkspaceServerTools(fakeDeps());
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.spec.toolSpec?.description]))).toStrictEqual({
      list_feedback_forms: 'All embeddable feedback forms with their settings (enabled, title, question, rating, linked project).',
      get_feedback_form_stats: 'Submission count, average rating and rating count of one feedback form.',
      get_feedback_form_submissions: 'The newest submissions of one feedback form (text, rating, sentiment, category).',
      get_prioritization: 'The prioritization board: each row (a project\u2019s set of documents), the signed-in user\u2019s own scores and '
        + 'the team aggregate (mean impact, time to market, confidence, strategic fit; reviewer count; spread). Use '
        + 'list_projects to name the projects.',
      list_scrapers: 'Configured web scrapers (id, name, enabled, target URLs, schedule, last run).',
      get_scraper_status: 'Status of a scraper\u2019s latest run (status, pages scraped, items found, errors).',
      get_categories_config: 'The configured feedback categories and subcategories used by the enrichment pipeline.',
      get_brand_settings: 'Brand settings: brand name, handles, hashtags and URLs to track. Read before proposing save_brand_settings.',
    });
  });

  it.each(['list_feedback_forms', 'get_prioritization', 'list_scrapers', 'get_categories_config', 'get_brand_settings'])(
    '%s refuses any argument',
    async (name) => {
      const deps = fakeDeps();
      await expect(serverTool(deps, name).execute({ extra: 1 }, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
      expect(deps.calls).toStrictEqual([]);
    },
  );
});

describe('forms tools', () => {
  it('list_feedback_forms GETs every form as the caller and keeps the allowlisted fields', async () => {
    const forms = [{ form_id: 'f1', name: 'NPS', enabled: true, secret: 'x', title: 't'.repeat(301) }, 'not a record'];
    const { calls, result, subs } = await runTool('list_feedback_forms', 'GET /feedback-forms', { forms });
    expect(calls).toStrictEqual([{ fn: 'feedbackForms', path: '/feedback-forms', resource: '/feedback-forms', method: 'GET' }]);
    expect(subs).toStrictEqual(['user-sub']);
    expect(result).toStrictEqual({
      content: JSON.stringify({ count: 1, forms: [{ form_id: 'f1', name: 'NPS', enabled: true, title: `${'t'.repeat(300)}…` }] }),
    });
  });

  it('get_feedback_form_stats reads one form and wraps its stats', async () => {
    const { calls, result } = await runTool('get_feedback_form_stats', 'GET /feedback-forms/a%3A1/stats', {
      stats: { total: 4 },
      other: 1,
    }, { form_id: ID });
    expect(calls).toStrictEqual([{
      fn: 'feedbackForms',
      path: '/feedback-forms/a%3A1/stats',
      resource: '/feedback-forms/{form_id}/stats',
      pathParameters: { form_id: ID },
      method: 'GET',
    }]);
    expect(result).toStrictEqual({ content: '{"form_id":"a:1","stats":{"total":4}}' });
  });

  it('get_feedback_form_stats passes a non-record answer through', async () => {
    const { result } = await runTool('get_feedback_form_stats', 'GET /feedback-forms/a%3A1/stats', ['raw'], { form_id: ID });
    expect(result).toStrictEqual({ content: '["raw"]' });
  });

  it('get_feedback_form_submissions defaults the limit to 20 and shapes rows and source cards', async () => {
    const row = { feedback_id: 'fb1', original_text: 'o'.repeat(501), rating: 5, pk: 'SOURCE#form' };
    const { calls, result } = await runTool('get_feedback_form_submissions', 'GET /feedback-forms/a%3A1/submissions', {
      submissions: [row],
    }, { form_id: ID });
    expect(calls).toStrictEqual([{
      fn: 'feedbackForms',
      path: '/feedback-forms/a%3A1/submissions',
      resource: '/feedback-forms/{form_id}/submissions',
      pathParameters: { form_id: ID },
      query: { limit: 20 },
      method: 'GET',
    }]);
    expect(result).toStrictEqual({
      content: JSON.stringify({ form_id: ID, returned: 1, submissions: [{ feedback_id: 'fb1', original_text: `${'o'.repeat(500)}…`, rating: 5 }] }),
      sources: [{ feedback_id: 'fb1', original_text: 'o'.repeat(501), rating: 5 }],
    });
  });

  it.each([1, 50])('get_feedback_form_submissions passes limit %i', async (limit) => {
    const { calls } = await runTool('get_feedback_form_submissions', 'GET /feedback-forms/a%3A1/submissions', {}, { form_id: ID, limit });
    expect(calls.map((call) => call.query)).toStrictEqual([{ limit }]);
  });

  it.each([0, 51, 2.5])('get_feedback_form_submissions refuses limit %d', async (limit) => {
    const deps = fakeDeps();
    const run = serverTool(deps, 'get_feedback_form_submissions').execute({ form_id: ID, limit }, fakeContext());
    await expect(run).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });
});

describe('prioritization, scrapers and settings tools', () => {
  it('get_prioritization returns the board as is', async () => {
    const { calls, result } = await runTool('get_prioritization', 'GET /projects/prioritization', { rows: [1] });
    expect(calls).toStrictEqual([{ fn: 'projects', path: '/projects/prioritization', resource: '/projects/prioritization', method: 'GET' }]);
    expect(result).toStrictEqual({ content: '{"rows":[1]}' });
  });

  it('list_scrapers GETs /scrapers and counts the configs', async () => {
    const { calls, result } = await runTool('list_scrapers', 'GET /scrapers', { scrapers: [{ id: 's1', urls: ['u'] }] });
    expect(calls).toStrictEqual([{ fn: 'scrapers', path: '/scrapers', resource: '/scrapers', method: 'GET' }]);
    expect(result).toStrictEqual({ content: '{"count":1,"scrapers":[{"id":"s1","urls":["u"]}]}' });
  });

  it('get_scraper_status encodes the path segment but not the proxy parameter', async () => {
    const { calls, result } = await runTool('get_scraper_status', 'GET /scrapers/a%3A1/status', { status: 'ok' }, { scraper_id: ID });
    expect(calls).toStrictEqual([{
      fn: 'scrapers',
      path: '/scrapers/a%3A1/status',
      resource: '/scrapers/{proxy+}',
      pathParameters: { proxy: 'a:1/status' },
      method: 'GET',
    }]);
    expect(result).toStrictEqual({ content: '{"status":"ok"}' });
  });

  it.each([
    ['get_categories_config', 'categories'],
    ['get_brand_settings', 'brand'],
  ])('%s reads /settings/%s', async (name, route) => {
    const { calls, result } = await runTool(name, `GET /settings/${route}`, { route });
    expect(calls).toStrictEqual([{
      fn: 'settings',
      method: 'GET',
      path: `/settings/${route}`,
      resource: '/settings/{proxy+}',
      pathParameters: { proxy: route },
    }]);
    expect(result).toStrictEqual({ content: JSON.stringify({ route }) });
  });
});
