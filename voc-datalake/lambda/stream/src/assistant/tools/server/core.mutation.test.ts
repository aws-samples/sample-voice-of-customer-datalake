/**
 * What the Stryker run on core.ts found that the earlier specs could not see: the model-facing tool
 * specs (descriptions, argument schemas, required lists) were never read, so any of them could be
 * blanked; web_search's source mapping and list_projects ran under no test at all; the navigation
 * allowlist was only probed with a handful of paths, so dropping an anchor or a length bound on any
 * route passed; and the exact call shapes (similar items, the feedback item), the trims, the
 * strict empty-argument tools and every error message the model reads were unpinned.
 */
import { EventType } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { isRecord } from '../format.js';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { isAllowedNavigationPath } from './core.js';

function specOf(name: string): { description: string; schema: unknown } {
  const spec = serverTool(fakeDeps(), name).spec.toolSpec;
  return { description: spec?.description ?? '', schema: spec?.inputSchema?.json };
}

/** The property names of a JSON schema, in declaration order. */
function propertyNames(schema: unknown): string[] {
  const properties = isRecord(schema) ? schema.properties : undefined;
  return isRecord(properties) ? Object.keys(properties) : [];
}

describe('every core tool tells the model what it does', () => {
  it.each([
    ['get_metrics', 'Pre-computed dashboard metrics over the whole dataset for a time window: summary (totals, average sentiment, urgent count, daily series), sentiment, categories, sources or personas breakdown, dimensions (counts and sentiment per value of one dimension, `key` from list_dimensions), or github (GitHub Issues per software release and per label: volume, sentiment, top complaints/errors, what is new in the latest release). Exact counts — prefer this over searching for "how many" / distribution questions. The window defaults to the page time range.'],
    ['get_feedback_item', 'Read one feedback item in full (defaults to the item open on the current page), optionally with similar items from the same category.'],
    ['list_categories', 'The feedback categories the signed-in user can see: name (the id used in filters and in set_feedback_category), description, the product it belongs to, and its subcategories. Read this before proposing a category change or filtering by category.'],
    ['list_dimensions', 'The feedback dimensions an admin configured (e.g. product, module, user type): key, label, description, parent dimension and allowed values. Read this before filtering with `dims` or reading get_metrics(metric="dimensions").'],
    ['list_projects', 'List the research projects the user can see (id, name, description, status, persona/document counts).'],
    ['get_project', 'Overview of one project (defaults to the project open on the current page): the signed-in user\u2019s access (role, can_edit, can_manage), metadata, its personas (id, name, tagline) and its documents (id, title, type, size). Does not return document text — use get_documents for that.'],
    ['suggest_navigation', 'Offer the user a link chip to another page of the app (e.g. "/projects/<id>", "/feedback/<id>", "/problems"). Only app routes are accepted. The user decides whether to follow it.'],
  ])('%s', (name, description) => {
    expect(specOf(name).description).toBe(description);
  });
});

describe('the argument schemas the model fills in', () => {
  it('get_metrics: metric (required, one of seven), days, source, key and the item filters', () => {
    const { schema } = specOf('get_metrics');
    expect(schema).toMatchObject({
      required: ['metric'],
      additionalProperties: false,
      properties: {
        metric: {
          type: 'string',
          enum: ['summary', 'sentiment', 'categories', 'sources', 'personas', 'github', 'dimensions'],
          description: 'Which breakdown to read.',
        },
        days: { type: 'integer', minimum: 0, maximum: 9999, description: 'Window in days (default: page time range). 0 = all time.' },
        source: { type: 'string', description: 'Source platform filter (every metric except github, which is GitHub Issues only).' },
        key: { type: 'string', description: 'Dimension key; required for metric=dimensions.' },
      },
    });
    expect(propertyNames(schema)).toStrictEqual(['metric', 'days', 'source', 'key', 'channel', 'tag', 'dims']);
  });

  it.each([
    ['get_feedback_item', {
      feedback_id: { type: 'string', maxLength: 128, description: 'Feedback id; omit to use the item on screen.' },
      include_similar: { type: 'boolean', description: 'Also return up to 5 similar items.' },
    }, []],
    ['get_project', { project_id: { type: 'string', maxLength: 128, description: 'Project id; omit to use the project on screen.' } }, []],
    ['suggest_navigation', {
      path: { type: 'string', description: 'App route, e.g. /projects/proj_123 or /categories.' },
      label: { type: 'string', maxLength: 80, description: 'Short link text.' },
    }, ['path', 'label']],
  ])('%s', (name, properties, required) => {
    expect(specOf(name).schema).toStrictEqual({ type: 'object', properties, required, additionalProperties: false });
  });
});

describe('get_metrics arguments', () => {
  it('trims the source and sends only the window and the source for a sourced metric (no key)', async () => {
    const deps = fakeDeps({ 'GET /metrics/summary': {} });
    await serverTool(deps, 'get_metrics').execute({ metric: 'summary', source: '  webscraper  ', key: 'product' }, fakeContext());
    const sent = Object.entries(deps.calls[0]?.call.query ?? {}).filter(([, value]) => value !== undefined);
    expect(sent).toStrictEqual([['days', 30], ['source', 'webscraper']]);
  });

  it('sends the trimmed key for metric=dimensions', async () => {
    const deps = fakeDeps({ 'GET /metrics/dimensions': {} });
    await serverTool(deps, 'get_metrics').execute({ metric: 'dimensions', key: ' product ' }, fakeContext());
    expect(deps.calls[0]?.call.query?.key).toBe('product');
  });

  it('refuses metric=dimensions without a key, naming the argument', async () => {
    await expect(serverTool(fakeDeps(), 'get_metrics').execute({ metric: 'dimensions' }, fakeContext())).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Invalid arguments — key: the dimensions metric needs `key` (a dimension key from list_dimensions)',
    });
  });
});

describe('get_metrics partial-window warning', () => {
  const WARNING = '\n⚠️ is_partial=true: the figures are a lower bound for this window — say so.';

  it.each([
    [{ is_partial: true }, `{"is_partial":true}${WARNING}`],
    [{ is_partial: false }, '{"is_partial":false}'],
    [{ is_partial: 'yes' }, '{"is_partial":"yes"}'],
    [null, 'null'],
  ])('body %j → %j', async (body, content) => {
    const deps = fakeDeps({ 'GET /metrics/summary': body });
    await expect(serverTool(deps, 'get_metrics').execute({ metric: 'summary' }, fakeContext())).resolves.toStrictEqual({ content });
  });
});

describe('get_feedback_item', () => {
  const ITEM = { feedback_id: 'f1', category: 'delivery', original_text: 'a'.repeat(5000), pk: 'SOURCE#x' };
  const SIMILAR = { feedback_id: 'f2', original_text: 'b'.repeat(400) };

  it('reads the item and its five similar items from the metrics Lambda', async () => {
    const deps = fakeDeps({ 'GET /feedback/f1': ITEM, 'GET /feedback/f1/similar': { items: [SIMILAR] } });
    await serverTool(deps, 'get_feedback_item').execute({ feedback_id: 'f1', include_similar: true }, fakeContext());
    expect(deps.calls.map((c) => c.call)).toStrictEqual([
      { fn: 'metrics', method: 'GET', path: '/feedback/f1', resource: '/feedback/{id}', pathParameters: { id: 'f1' } },
      {
        fn: 'metrics', method: 'GET', path: '/feedback/f1/similar', resource: '/feedback/{id}/similar',
        pathParameters: { id: 'f1' }, query: { limit: 5 },
      },
    ]);
  });

  it('returns the item clipped at 4000 and the similar items at 300 characters', async () => {
    const deps = fakeDeps({ 'GET /feedback/f1': ITEM, 'GET /feedback/f1/similar': { items: [SIMILAR] } });
    const result = await serverTool(deps, 'get_feedback_item').execute({ feedback_id: 'f1', include_similar: true }, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({
      item: { feedback_id: 'f1', category: 'delivery', original_text: `${'a'.repeat(4000)}…` },
      similar: [{ feedback_id: 'f2', original_text: `${'b'.repeat(300)}…` }],
    });
    expect(result.sources?.map((s) => s.feedback_id)).toStrictEqual(['f1', 'f2']);
  });

  it('without include_similar reads only the item and lists no similar items', async () => {
    const deps = fakeDeps({ 'GET /feedback/f1': { feedback_id: 'f1' } });
    const result = await serverTool(deps, 'get_feedback_item').execute({ feedback_id: 'f1' }, fakeContext());
    expect(result).toStrictEqual({ content: '{"item":{"feedback_id":"f1"}}', sources: [{ feedback_id: 'f1' }] });
    expect(deps.calls).toHaveLength(1);
  });

  it('an item without an id yields no source card', async () => {
    const deps = fakeDeps({ 'GET /feedback/f1': { category: 'delivery' } });
    const result = await serverTool(deps, 'get_feedback_item').execute({ feedback_id: 'f1' }, fakeContext());
    expect(result.sources).toStrictEqual([]);
  });

  it.each([[null], [['f1']], ['text']])('refuses a non-object item body %j as unavailable', async (body) => {
    const deps = fakeDeps({ 'GET /feedback/f1': body });
    await expect(serverTool(deps, 'get_feedback_item').execute({ feedback_id: 'f1' }, fakeContext()))
      .rejects.toMatchObject({ code: 'unavailable', message: 'The feedback item could not be read.' });
  });
});

describe('search_feedback sources', () => {
  it('cards the first five items only', async () => {
    const records = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => ({ feedback_id: id }));
    const deps = fakeDeps({
      'GET /feedback/access': { all: true, categories: [], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] },
    }, { searchFeedback: () => Promise.resolve({ items: records, formatted: 'found' }) });
    const result = await serverTool(deps, 'search_feedback').execute({ query: 'x' }, fakeContext());
    expect(result).toStrictEqual({ content: 'found', sources: records.slice(0, 5) });
  });
});

describe('list_projects', () => {
  it('reads /projects as the caller and keeps only the listed fields of record entries', async () => {
    const project = {
      project_id: 'p1', name: 'Checkout', description: 'd', status: 'active', persona_count: 2,
      document_count: 3, updated_at: '2026-01-01', access: 'owner', pk: 'PROJECT#p1', members: ['x'],
    };
    const deps = fakeDeps({ 'GET /projects': { projects: [project, 'junk', { name: 'n'.repeat(400) }] } });
    const result = await serverTool(deps, 'list_projects').execute({}, fakeContext());
    expect(deps.calls).toStrictEqual([{ call: { fn: 'projects', method: 'GET', path: '/projects', resource: '/projects' }, sub: 'user-sub' }]);
    expect(JSON.parse(result.content)).toStrictEqual({
      count: 2,
      projects: [
        {
          project_id: 'p1', name: 'Checkout', description: 'd', status: 'active', persona_count: 2,
          document_count: 3, updated_at: '2026-01-01', access: 'owner',
        },
        { name: `${'n'.repeat(300)}…` },
      ],
    });
  });

  it.each([[null], [[]], [{ projects: 'bad' }], [{}]])('reads body %j as no projects', async (body) => {
    const deps = fakeDeps({ 'GET /projects': body });
    await expect(serverTool(deps, 'list_projects').execute({}, fakeContext()))
      .resolves.toStrictEqual({ content: '{"count":0,"projects":[]}' });
  });
});

describe('the argument-less tools refuse arguments', () => {
  it.each(['list_categories', 'list_dimensions', 'list_projects'])('%s', async (name) => {
    await expect(serverTool(fakeDeps(), name).execute({ extra: 1 }, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('get_project', () => {
  it('names project_id when neither the model nor the page gives one', async () => {
    await expect(serverTool(fakeDeps(), 'get_project').execute({}, fakeContext())).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'Missing project_id: none was given and the current page has no default.',
    });
  });
});

describe('suggest_navigation', () => {
  it('trims the path and label, emits the chip and tells the model', async () => {
    const ctx = fakeContext();
    const result = await serverTool(fakeDeps(), 'suggest_navigation').execute({ path: '  /problems ', label: ' Problems  ' }, ctx);
    expect(ctx.events).toStrictEqual([{ type: EventType.CUSTOM, name: 'assistant.navigation', value: { path: '/problems', label: 'Problems' } }]);
    expect(result).toStrictEqual({ content: 'A link to "Problems" (/problems) is shown to the user.' });
  });

  it('quotes at most 80 characters of a refused path', async () => {
    const path = `/${'x'.repeat(150)}`;
    await expect(serverTool(fakeDeps(), 'suggest_navigation').execute({ path, label: 'x' }, fakeContext())).rejects.toMatchObject({
      code: 'invalid_input',
      message: `"${path.slice(0, 80)}" is not an app route that can be linked.`,
    });
  });
});

const PAGE_ROUTES = [
  '/', '/dashboard', '/categories', '/problems', '/projects', '/prioritization', '/data-explorer',
  '/scrapers', '/feedback-forms', '/settings', '/memory', '/agents',
];
const ID_ROUTES = ['/feedback', '/projects', '/agents'];
const LONGEST_ID = `a.b:c-${'d'.repeat(122)}`;

describe('the navigation allowlist', () => {
  it.each(PAGE_ROUTES)('accepts %s exactly, not under a prefix or with a suffix', (route) => {
    expect([route, `/x${route}`, `${route}/x/y`, `${route}x`].map(isAllowedNavigationPath)).toStrictEqual([true, false, false, false]);
  });

  it.each(ID_ROUTES)('accepts %s/<id> for a plain id of 1–128 characters, nothing else', (route) => {
    expect([
      `${route}/f1`, `${route}/${LONGEST_ID}`, `${route}/${LONGEST_ID}e`, `/x${route}/f1`, `${route}/f1/x`, `${route}/a b`, `${route}/`,
    ].map(isAllowedNavigationPath)).toStrictEqual([true, true, false, false, false, false, false]);
  });
});

describe('web_search', () => {
  it('drops sources without a url and titles untitled ones by their url', async () => {
    const deps = fakeDeps({}, {
      webSearch: () => Promise.resolve({
        content: 'results',
        webSources: [
          { title: '', url: 'https://a.example', text: 'a', published_date: '' },
          { title: 'Nothing', url: '', text: 'n', published_date: '' },
          { title: 'B', url: 'https://b.example', text: 'b', published_date: '' },
        ],
      }),
    });
    await expect(serverTool(deps, 'web_search').execute({ query: 'q' }, fakeContext())).resolves.toStrictEqual({
      content: 'results',
      webSources: [{ title: 'https://a.example', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }],
    });
  });
});
