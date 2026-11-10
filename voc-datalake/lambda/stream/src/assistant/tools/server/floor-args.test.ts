/**
 * The REST-backed feedback tools under the user's floor: narrowing allowed, widening intersected
 * to nothing, and what a route cannot express refused before any call.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import type { PageContext } from '../../contract.js';
import { floorFromFilters } from './feedback-floor.js';
import { floorConflicts, floorNote, floorQuery } from './floor-args.js';

type Filters = NonNullable<PageContext['filters']>;
const LIST_FIELDS = new Set(['source', 'category', 'sentiment', 'channel', 'tag', 'dims', 'rating', 'urgent'] as const);

function onCategories(filters: Filters) {
  const page: PageContext = { kind: 'categories', path: '/categories', filters };
  return fakeContext('categories', page, { props: { page, days: 7 } });
}

function onChat(filters: Filters, limit?: number) {
  const page: PageContext = { kind: 'chat', path: '/chat' };
  return fakeContext('chat', page, { props: { page, days: 7, scope: { filters, ...(limit === undefined ? {} : { limit }) } } });
}

const LIST = { 'GET /feedback': { total: 3, items: [] }, 'GET /feedback/urgent': { items: [] } };

describe('floorQuery', () => {
  it('sends the floor value when the model passes none, and the model value inside it', () => {
    const floor = floorFromFilters({ category: 'delivery', rating: '2', rating_dir: 'below', urgent: '1' });
    expect(floorQuery(floor, {}, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { category: 'delivery', rating_max: 2, urgent: '1' } });
    expect(floorQuery(floorFromFilters({ category: 'a,b' }), { category: 'b' }, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { category: 'b' } });
  });

  it('sends the usefulness floor to a route that filters on it, and refuses one that does not', () => {
    const withUsefulness = new Set([...LIST_FIELDS, 'usefulness'] as const);
    expect(floorQuery(floorFromFilters({ usefulness: 'high' }), {}, 'list_feedback', withUsefulness))
      .toStrictEqual({ kind: 'query', query: { usefulness: 'high' } });
    expect(() => floorQuery(floorFromFilters({ usefulness: 'high' }), {}, 'list_feedback', LIST_FIELDS)).toThrow(/usefulness/);
  });

  it('still calls the route when the user set no filter (an empty floor holds no list)', () => {
    expect(floorFromFilters({}).lists).toStrictEqual({});
    expect(floorQuery(floorFromFilters({}), { category: 'delivery' }, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { category: 'delivery' } });
  });

  it('answers empty, never a refusal or a call, for a floor that admits nothing (a refused chat scope)', () => {
    const refused = floorFromFilters({ sentiment: 'none' });
    const metricsFields = new Set(['source', 'channel', 'tag', 'dims', 'rating', 'urgent'] as const);
    expect(floorQuery(refused, {}, 'get_metrics', metricsFields).kind).toBe('empty');
    expect(floorQuery(refused, {}, 'list_feedback', LIST_FIELDS).kind).toBe('empty');
  });

  it('answers empty for an argument outside the floor (intersected, not obeyed)', () => {
    const outcome = floorQuery(floorFromFilters({ source: 'webscraper' }), { source: 'manual_import' }, 'list_feedback', LIST_FIELDS);
    expect(outcome.kind).toBe('empty');
    expect(outcome.kind === 'empty' ? outcome.content : '').toContain('"asked":"manual_import"');
  });

  it('asks for one call per value when the floor allows several', () => {
    expect(() => floorQuery(floorFromFilters({ category: 'a,b' }), {}, 'list_feedback', LIST_FIELDS))
      .toThrow(/once per value/);
  });

  it('refuses a floor field the route cannot filter on', () => {
    expect(() => floorQuery(floorFromFilters({ subcategory: 'late' }), {}, 'list_feedback', LIST_FIELDS)).toThrow(/subcategory/);
    expect(() => floorQuery(floorFromFilters({ q: 'late' }), {}, 'list_feedback', LIST_FIELDS)).toThrow(/search text/);
  });

  it('merges dims: floor alternatives kept, the model narrows a key, a value outside is empty', () => {
    const floor = floorFromFilters({ dims: 'product:app|web' });
    expect(floorQuery(floor, { dims: { module: 'x' } }, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { dims: 'product:app|web,module:x' } });
    expect(floorQuery(floor, { dims: { product: 'web' } }, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { dims: 'product:web' } });
    expect(floorQuery(floor, { dims: { product: 'tv' } }, 'list_feedback', LIST_FIELDS).kind).toBe('empty');
  });

  it('passes the model arguments through unchanged without a floor', () => {
    expect(floorQuery(floorFromFilters(undefined), { source: 's', tag: 't' }, 'list_feedback', LIST_FIELDS))
      .toStrictEqual({ kind: 'query', query: { source: 's', tag: 't' } });
  });
});

describe('floorConflicts / floorNote', () => {
  it('names the arguments past the floor, and says nothing without one', () => {
    const floor = floorFromFilters({ urgent: '1', tag: 'VIP' });
    expect(floorConflicts(floor, { urgency: 'low', tag: 'vip' })).toStrictEqual([{ field: 'urgency', asked: 'low', allowed: ['high'] }]);
    expect(floorNote(floorFromFilters(undefined), [])).toBe('');
    expect(floorNote(floor, [])).toContain('limited to the filters the user set');
  });
});

describe('the REST feedback tools under the floor', () => {
  it('list_feedback on a filtered Categories page reads only the page category', async () => {
    const deps = fakeDeps(LIST);
    await serverTool(deps, 'list_feedback').execute({}, onCategories({ category: 'delivery', sentiment: 'negative' }));
    expect(deps.calls[0]?.call.query).toMatchObject({ category: 'delivery', sentiment: 'negative' });
  });

  it('list_feedback asked past the floor reads nothing', async () => {
    const deps = fakeDeps(LIST);
    const result = await serverTool(deps, 'list_feedback').execute({ category: 'billing' }, onCategories({ category: 'delivery' }));
    expect(deps.calls).toStrictEqual([]);
    expect(result.content).toContain('outside those filters');
  });

  it('list_feedback stops at the chat panel cap', async () => {
    const deps = fakeDeps(LIST);
    await serverTool(deps, 'list_feedback').execute({ limit: 50, offset: 980 }, onChat({}, 1000));
    expect(deps.calls[0]?.call.query).toMatchObject({ limit: 20, offset: 980 });
    const spent = await serverTool(deps, 'list_feedback').execute({ offset: 1000 }, onChat({}));
    expect(spent.content).toContain('caps a read');
    expect(deps.calls).toHaveLength(1);
  });

  it('get_urgent_feedback and get_entities carry the chat panel scope', async () => {
    const deps = fakeDeps({ ...LIST, 'GET /feedback/entities': { entities: {} } });
    await serverTool(deps, 'get_urgent_feedback').execute({}, onChat({ source: 'webscraper' }));
    await serverTool(deps, 'get_entities').execute({}, onChat({ source: 'webscraper', tag: 'VIP' }));
    expect(deps.calls.map((c) => c.call.query)).toMatchObject([{ source: 'webscraper' }, { source: 'webscraper', tag: 'VIP' }]);
  });

  it('get_entities refuses a category floor it cannot apply', async () => {
    const deps = fakeDeps();
    await expect(serverTool(deps, 'get_entities').execute({}, onCategories({ category: 'delivery' }))).rejects.toThrow(/category/);
    expect(deps.calls).toStrictEqual([]);
  });

  it('get_metrics applies the floor, takes one category on the sentiment view, and checks github against its source', async () => {
    const deps = fakeDeps({ 'GET /metrics/summary': {}, 'GET /metrics/sentiment': {}, 'GET /metrics/github': {} });
    const metrics = serverTool(deps, 'get_metrics');
    await metrics.execute({ metric: 'summary' }, onCategories({ source: 'webscraper', urgent: '1' }));
    await metrics.execute({ metric: 'sentiment' }, onCategories({ category: 'delivery' }));
    expect(deps.calls.map((c) => c.call.query)).toMatchObject([{ source: 'webscraper', urgent: '1' }, { category: 'delivery' }]);
    await expect(metrics.execute({ metric: 'summary' }, onCategories({ category: 'delivery' }))).rejects.toThrow(/category/);
    const github = await metrics.execute({ metric: 'github' }, onCategories({ source: 'webscraper' }));
    expect(github.content).toContain('outside those filters');
    expect(deps.calls).toHaveLength(2);
  });
});
