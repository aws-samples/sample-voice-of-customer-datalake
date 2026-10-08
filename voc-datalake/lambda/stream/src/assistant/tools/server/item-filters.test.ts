import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { itemFilterQuery, serializeDims } from './item-filters.js';

const dashboard = () => fakeContext('dashboard', {}, { props: { page: { kind: 'dashboard', path: '/' }, days: 7 } });
const FILTERS = { channel: 'email', tag: 'VIP', dims: { product: 'app', user_type: 'partner' } };
const FILTER_QUERY = { channel: 'email', tag: 'VIP', dims: 'product:app,user_type:partner' };

describe('the item filter helpers', () => {
  it('serialise dims as key:value pairs and drop an empty object', () => {
    expect(serializeDims({ product: 'app', module: 'billing' })).toBe('product:app,module:billing');
    expect(serializeDims({})).toBeUndefined();
    expect(itemFilterQuery({})).toStrictEqual({ channel: undefined, tag: undefined, dims: undefined });
  });
});

describe('get_metrics dimensions view', () => {
  it('reads /metrics/dimensions with the key and every filter', async () => {
    const deps = fakeDeps({ 'GET /metrics/dimensions': { key: 'module', values: {}, unassigned: 0 } });
    await serverTool(deps, 'get_metrics').execute({ metric: 'dimensions', key: 'module', ...FILTERS }, dashboard());
    expect(deps.calls[0]?.call).toMatchObject({
      path: '/metrics/dimensions',
      pathParameters: { proxy: 'dimensions' },
      query: { days: 7, key: 'module', source: undefined, ...FILTER_QUERY },
    });
  });

  it('refuses the dimensions view without a key, and a malformed dims, before any call', async () => {
    const deps = fakeDeps();
    const tool = serverTool(deps, 'get_metrics');
    await expect(tool.execute({ metric: 'dimensions' }, dashboard())).rejects.toThrow(/key/);
    await expect(tool.execute({ metric: 'categories', dims: { Product: 'app' } }, dashboard())).rejects.toThrow(/dims/);
    expect(deps.calls).toStrictEqual([]);
  });

  it.each(['summary', 'sources', 'personas', 'sentiment', 'categories'] as const)(
    'forwards source and every item filter to the %s view', async (metric) => {
      const deps = fakeDeps({ [`GET /metrics/${metric}`]: { total: 1 } });
      const result = await serverTool(deps, 'get_metrics').execute({ metric, source: 'web', ...FILTERS }, dashboard());
      expect(deps.calls[0]?.call.query).toMatchObject({ days: 7, source: 'web', ...FILTER_QUERY });
      expect(result.content).not.toContain('cannot be filtered');
    });

  it('forwards the item filters but not source to the github view', async () => {
    const deps = fakeDeps({ 'GET /metrics/github': { versions: [] } });
    await serverTool(deps, 'get_metrics').execute({ metric: 'github', source: 'web', ...FILTERS }, dashboard());
    expect(deps.calls[0]?.call.query).toMatchObject({ source: undefined, ...FILTER_QUERY });
  });
});

describe('the insights tools forward channel, tag and dims', () => {
  it.each([
    ['list_feedback', 'GET /feedback', { items: [] }],
    ['get_urgent_feedback', 'GET /feedback/urgent', { items: [] }],
    ['get_entities', 'GET /feedback/entities', { entities: {} }],
  ] as const)('%s', async (name, route, answer) => {
    const deps = fakeDeps({ [route]: answer });
    await serverTool(deps, name).execute(FILTERS, dashboard());
    expect(deps.calls[0]?.call.query).toMatchObject(FILTER_QUERY);
  });
});

describe('list_dimensions', () => {
  it('reads GET /settings/dimensions through the settings proxy', async () => {
    const deps = fakeDeps({ 'GET /settings/dimensions': { dimensions: [{ key: 'product', values: [] }] } });
    const result = await serverTool(deps, 'list_dimensions').execute({}, dashboard());
    expect(deps.calls[0]?.call).toMatchObject({ fn: 'settings', resource: '/settings/{proxy+}', pathParameters: { proxy: 'dimensions' } });
    expect(result.content).toContain('"product"');
  });
});
