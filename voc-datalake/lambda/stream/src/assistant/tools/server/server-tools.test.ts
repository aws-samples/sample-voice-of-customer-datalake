import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { AssistantToolError, describeToolError } from '../errors.js';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { isAllowedNavigationPath } from './core.js';
import { MAX_WINDOW_DAYS } from './common.js';
import { ALL_TIME_DAYS, forwardedPropsSchema, type PageContext } from '../../contract.js';

const FEEDBACK = {
  pk: 'SOURCE#webscraper',
  sk: 'FEEDBACK#f1',
  gsi1pk: 'DATE#2026-01-01',
  feedback_id: 'f1',
  source_platform: 'webscraper',
  category: 'delivery',
  sentiment_label: 'negative',
  urgency: 'high',
  original_text: 'Late again',
};

/** The source half of `GET /feedback/access` when no source is hidden. */
const ALL_SOURCES = { sources_all: true, sources: [], source_rule: 'all', sources_denied: [] };

describe('get_metrics', () => {
  it('reads /metrics/{metric} with the page window and the source filter', async () => {
    const deps = fakeDeps({ 'GET /metrics/sources': { period_days: 14, is_partial: true, sources: { webscraper: 3 } } });
    const ctx = fakeContext('dashboard', {}, { props: { page: { kind: 'dashboard', path: '/' }, days: 14, dateBasis: 'review' } });

    const result = await serverTool(deps, 'get_metrics').execute({ metric: 'sources', source: 'webscraper' }, ctx);

    expect(deps.calls[0]?.call).toMatchObject({
      fn: 'metrics',
      method: 'GET',
      path: '/metrics/sources',
      resource: '/metrics/{proxy+}',
    });
    expect(deps.calls[0]?.call.query).toMatchObject({ days: 14, date_basis: 'review', source: 'webscraper' });
    expect(deps.calls[0]?.sub).toBe('user-sub');
    const missing = ['"webscraper":3', 'lower bound'].filter((text) => !result.content.includes(text));
    expect(missing).toStrictEqual([]);
  });

  it('reads the GitHub Issues per-release breakdown as metric "github"', async () => {
    const deps = fakeDeps({ 'GET /metrics/github': { is_partial: false, latest_version: '0.4.2', versions: [] } });

    const result = await serverTool(deps, 'get_metrics').execute({ metric: 'github', source: 'webscraper' }, fakeContext());

    expect(deps.calls[0]?.call).toMatchObject({ path: '/metrics/github', pathParameters: { proxy: 'github' } });
    expect(deps.calls[0]?.call.query?.source).toBeUndefined();
    expect(result.content).toContain('0.4.2');
  });

  it('rejects an unknown metric as invalid input', async () => {
    const tool = serverTool(fakeDeps(), 'get_metrics');
    await expect(tool.execute({ metric: 'revenue' }, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('passes days=0 (all time) through to the API and accepts up to MAX_WINDOW_DAYS', async () => {
    const deps = fakeDeps({ 'GET /metrics/summary': { total_feedback: 1 } });
    const tool = serverTool(deps, 'get_metrics');
    await tool.execute({ metric: 'summary', days: 0 }, fakeContext());
    await tool.execute({ metric: 'summary', days: MAX_WINDOW_DAYS }, fakeContext());
    expect(deps.calls.map((c) => c.call.query?.days)).toStrictEqual([0, MAX_WINDOW_DAYS]);
    await expect(tool.execute({ metric: 'summary', days: MAX_WINDOW_DAYS + 1 }, fakeContext()))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('uses an all-time page window as-is', async () => {
    const deps = fakeDeps({ 'GET /metrics/summary': {} });
    const ctx = fakeContext('dashboard', {}, { props: { page: { kind: 'dashboard', path: '/' }, days: 0 } });
    await serverTool(deps, 'get_metrics').execute({ metric: 'summary' }, ctx);
    expect(deps.calls[0]?.call.query?.days).toBe(0);
  });
});

describe('the window bounds', () => {
  it('forwardedProps.days accepts exactly ALL_TIME_DAYS..MAX_WINDOW_DAYS', () => {
    const page: PageContext = { kind: 'dashboard', path: '/' };
    expect(forwardedPropsSchema.safeParse({ page, days: ALL_TIME_DAYS }).success).toBe(true);
    expect(forwardedPropsSchema.safeParse({ page, days: MAX_WINDOW_DAYS }).success).toBe(true);
    expect(forwardedPropsSchema.safeParse({ page, days: MAX_WINDOW_DAYS + 1 }).success).toBe(false);
    expect(forwardedPropsSchema.safeParse({ page, days: -1 }).success).toBe(false);
  });
});

describe('list_categories', () => {
  const CONFIG = {
    categories: [
      {
        name: 'delivery', description: 'Shipping', product: 'Logistics',
        owners: [{ sub: 'owner-sub', username: 'olivia', email: 'olivia@example.com' }],
        subcategories: [{ name: 'late', description: 'Late parcels' }],
      },
      { name: 'billing', description: 'Invoices', product: 'Payments' },
      { description: 'nameless entry is dropped' },
    ],
    updated_at: '2026-01-01',
  };

  it('lists only the categories in the caller scope, without owners', async () => {
    const deps = fakeDeps({
      'GET /feedback/access': { all: false, categories: ['delivery'], ...ALL_SOURCES },
      'GET /settings/categories': CONFIG,
    });
    const result = await serverTool(deps, 'list_categories').execute({}, fakeContext());
    const parsed: unknown = JSON.parse(result.content);
    expect(parsed).toStrictEqual({
      count: 1,
      note: 'Only the categories this user may see are listed.',
      categories: [{
        name: 'delivery', description: 'Shipping', product: 'Logistics',
        subcategories: [{ name: 'late', description: 'Late parcels' }],
      }],
    });
    expect(result.content).not.toContain('olivia');
  });

  it('lists every category for an unrestricted caller', async () => {
    const deps = fakeDeps({ 'GET /feedback/access': { all: true, categories: [], ...ALL_SOURCES }, 'GET /settings/categories': CONFIG });
    const result = await serverTool(deps, 'list_categories').execute({}, fakeContext());
    expect(result.content).toContain('"count":2');
    expect(result.content).not.toContain('"note"');
  });

  it('reports a failed config read as unavailable, not as zero categories', async () => {
    const deps = fakeDeps({
      'GET /feedback/access': { all: true, categories: [], ...ALL_SOURCES },
      'GET /settings/categories': { categories: [], error: 'Failed to retrieve categories' },
    });
    await expect(serverTool(deps, 'list_categories').execute({}, fakeContext()))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('fails closed when the scope cannot be read', async () => {
    const deps = fakeDeps({ 'GET /settings/categories': CONFIG });
    await expect(serverTool(deps, 'list_categories').execute({}, fakeContext()))
      .rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('get_feedback_item', () => {
  it('defaults to the item on screen, strips storage keys from sources and adds similar items', async () => {
    const deps = fakeDeps({
      'GET /feedback/f1': FEEDBACK,
      'GET /feedback/f1/similar': { items: [{ ...FEEDBACK, feedback_id: 'f2' }] },
    });
    const result = await serverTool(deps, 'get_feedback_item')
      .execute({ include_similar: true }, fakeContext('feedback', { feedbackId: 'f1' }));

    expect(result.sources?.map((source) => source.feedback_id)).toStrictEqual(['f1', 'f2']);
    const first = result.sources?.at(0) ?? {};
    expect(['pk', 'gsi1pk'].filter((key) => key in first)).toStrictEqual([]);
    expect(result.content).not.toContain('SOURCE#');
    expect(deps.calls[1]?.call.resource).toBe('/feedback/{id}/similar');
  });

  it('asks for an id when the page has none', async () => {
    await expect(serverTool(fakeDeps(), 'get_feedback_item').execute({}, fakeContext()))
      .rejects.toThrow('Missing feedback_id');
  });
});

describe('get_project', () => {
  it('summarises without document content', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1': {
        project: { pk: 'PROJECT#proj_1', sk: 'META', project_id: 'proj_1', name: 'Checkout', status: 'active' },
        personas: [{ sk: 'PERSONA#p1', persona_id: 'p1', name: 'Pat', tagline: 'Busy', pain_points: { a: 1 } }],
        documents: [
          { sk: 'PRD#d1', document_id: 'd1', document_type: 'prd', title: 'PRD', content: 'secret body text' },
          { sk: 'PROTOTYPE#x', document_id: 'x', document_type: 'prototype', title: 'Proto', prototype_url: 'https://x' },
        ],
      },
    });
    const result = await serverTool(deps, 'get_project').execute({}, fakeContext('project', { projectId: 'proj_1' }));
    const parsed: unknown = JSON.parse(result.content);

    expect(parsed).toStrictEqual({
      project: { project_id: 'proj_1', name: 'Checkout', status: 'active' },
      personas: [{ persona_id: 'p1', name: 'Pat', tagline: 'Busy' }],
      documents: [
        { document_id: 'd1', document_type: 'prd', title: 'PRD', content_chars: 16 },
        { document_id: 'x', document_type: 'prototype', title: 'Proto', prototype: true },
      ],
    });
  });

  it('surfaces a 403 from the API as a model-readable permission error', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_2': new AssistantToolError('not_permitted', 'Not permitted — no access.'),
    });
    const failure = serverTool(deps, 'get_project').execute({ project_id: 'proj_2' }, fakeContext());
    await expect(failure).rejects.toMatchObject({ code: 'not_permitted' });
    expect(describeToolError(await failure.catch((err: unknown) => err))).toBe('Not permitted — no access.');
  });
});

describe('get_documents', () => {
  it('reads full content through chat-context and reports missing and prototype documents', async () => {
    const deps = fakeDeps({
      'POST /projects/proj_1/chat-context': {
        project: { sk: 'META', name: 'Checkout' },
        personas: [],
        documents: [
          { sk: 'PRD#d1', document_id: 'd1', document_type: 'prd', title: 'PRD', content: '# Body' },
          { sk: 'PROTOTYPE#x', document_id: 'x', document_type: 'prototype', title: 'Proto' },
        ],
      },
    });
    const result = await serverTool(deps, 'get_documents')
      .execute({ document_ids: ['d1', 'x', 'gone'] }, fakeContext('project', { projectId: 'proj_1' }));

    expect(deps.calls[0]?.call.body).toStrictEqual({ selected_document_ids: ['d1', 'x', 'gone'] });
    expect(result.content).toContain('# Body');
    expect(result.content).toContain('Prototype HTML is not available as text.');
    expect(result.content).toContain('[ID: gone]\nNot found in this project.');
  });

  it('marks truncated documents', async () => {
    const deps = fakeDeps({
      'POST /projects/proj_1/chat-context': {
        project: { name: 'P' },
        personas: [],
        documents: [{ sk: 'DOC#d1', document_id: 'd1', title: 'Big', content: 'x'.repeat(50_000) }],
      },
    });
    const result = await serverTool(deps, 'get_documents').execute({ project_id: 'proj_1', document_ids: ['d1'] }, fakeContext());
    expect(result.content).toContain('[TRUNCATED: showing the first 40000 of 50000 characters.');
  });
});

describe('list_project_jobs and get_persona', () => {
  it('lists jobs compactly', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1/jobs': { success: true, jobs: [{ job_id: 'j1', status: 'running', progress: 40, result: { big: 'x'.repeat(1000) } }] },
    });
    const result = await serverTool(deps, 'list_project_jobs').execute({}, fakeContext('project', { projectId: 'proj_1' }));
    expect(result.content).toContain('"job_id":"j1"');
    expect(result.content.length).toBeLessThan(500);
  });

  it('returns the persona without storage or avatar fields, and 404s an unknown persona', async () => {
    const deps = fakeDeps({
      'GET /projects/proj_1': {
        project: { sk: 'META' },
        personas: [{ pk: 'PROJECT#proj_1', persona_id: 'p1', name: 'Pat', avatar_url: 'https://cdn/x', avatar_prompt: 'draw' }],
        documents: [],
      },
    });
    const tool = serverTool(deps, 'get_persona');
    const ctx = fakeContext('project', { projectId: 'proj_1' });
    await expect(tool.execute({ persona_id: 'p1' }, ctx)).resolves.toStrictEqual({ content: '{"persona_id":"p1","name":"Pat"}' });
    await expect(tool.execute({ persona_id: 'p9' }, ctx)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('suggest_navigation', () => {
  it('emits an assistant.navigation CUSTOM event for an app route', async () => {
    const ctx = fakeContext();
    await serverTool(fakeDeps(), 'suggest_navigation').execute({ path: '/projects/proj_1', label: 'Open project' }, ctx);
    expect(ctx.events).toStrictEqual([{
      type: EventType.CUSTOM,
      name: 'assistant.navigation',
      value: { path: '/projects/proj_1', label: 'Open project' },
    }]);
  });

  it.each(['https://evil.example', '//evil.example', '/projects/a/b', '/admin', 'javascript:alert(1)'])(
    'refuses %s',
    async (path) => {
      expect(isAllowedNavigationPath(path)).toBe(false);
      const ctx = fakeContext();
      await expect(serverTool(fakeDeps(), 'suggest_navigation').execute({ path, label: 'x' }, ctx))
        .rejects.toMatchObject({ code: 'invalid_input' });
      expect(ctx.events).toStrictEqual([]);
    },
  );
});

describe('search_feedback and the scraper list', () => {
  it('passes the page window and the caller scope to the search and returns up to five sources', async () => {
    const seen: unknown[] = [];
    const deps = fakeDeps({ 'GET /feedback/access': { all: false, categories: ['delivery'], ...ALL_SOURCES } }, {
      searchFeedback: (input, filters) => {
        seen.push(input, filters);
        return Promise.resolve({ items: [FEEDBACK, { original_text: 'no id' }], formatted: 'Found 2 relevant feedback items' });
      },
    });
    const ctx = fakeContext('dashboard', {}, { props: { page: { kind: 'dashboard', path: '/' }, days: 7 } });
    const result = await serverTool(deps, 'search_feedback').execute({ query: 'late' }, ctx);
    expect(seen).toStrictEqual([
      { query: 'late' },
      {
        scope: {
          all: false, categoriesAll: false, categories: new Set(['delivery']),
          sourceRule: 'all', sources: new Set(), sourcesDenied: new Set(),
        },
        days: 7,
        dateBasis: undefined,
      },
    ]);
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'metrics', method: 'GET', path: '/feedback/access' });
    expect(result.sources?.map((source) => source.feedback_id)).toStrictEqual(['f1']);
  });

  it('reads the scope once per run', async () => {
    const deps = fakeDeps({ 'GET /feedback/access': { all: true, categories: [], ...ALL_SOURCES } });
    const ctx = fakeContext();
    await serverTool(deps, 'search_feedback').execute({}, ctx);
    await serverTool(deps, 'search_feedback').execute({}, ctx);
    expect(deps.calls.filter((c) => c.call.path === '/feedback/access')).toHaveLength(1);
  });

  it.each([
    ['the read fails', new AssistantToolError('unavailable', 'down')],
    ['the response is malformed', { all: 'yes' }],
    ['the response does not say whether a source is hidden', { all: true, categories: [] }],
  ])('fails closed — never searches — when %s', async (_label, answer) => {
    let searched = false;
    const deps = fakeDeps({ 'GET /feedback/access': answer }, {
      searchFeedback: () => {
        searched = true;
        return Promise.resolve({ items: [], formatted: '' });
      },
    });
    await expect(serverTool(deps, 'search_feedback').execute({}, fakeContext()))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(searched).toBe(false);
  });

  it('keeps only allowlisted scraper config keys', async () => {
    const deps = fakeDeps({
      'GET /scrapers': { scrapers: [{ id: 's1', name: 'Reviews', base_url: 'https://x', headers: { Cookie: 'session=1' } }] },
    });
    const result = await serverTool(deps, 'list_scrapers').execute({}, fakeContext('scrapers'));
    expect(result.content).toContain('"id":"s1"');
    expect(result.content).not.toContain('Cookie');
  });
});
