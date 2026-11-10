import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';

const BRANDS = { brands: [{ key: 'acme', label: 'Acme', total: 3 }], last_scan: null };

describe('get_radar', () => {
  it('lists the tracked brands as the caller when no brand is named', async () => {
    const deps = fakeDeps({ 'GET /radar': BRANDS });
    const result = await serverTool(deps, 'get_radar').execute({}, fakeContext());
    expect(deps.calls).toStrictEqual([{ call: { fn: 'radar', method: 'GET', path: '/radar', resource: '/radar' }, sub: 'user-sub' }]);
    expect(JSON.parse(result.content)).toStrictEqual(BRANDS);
  });

  it('reads one brand summary through the proxy resource with the window', async () => {
    const deps = fakeDeps({ 'GET /radar/brands/acme': { brand: { key: 'acme' }, love: [] } });
    await serverTool(deps, 'get_radar').execute({ brand: 'acme', view: 'summary', days: 30 }, fakeContext());
    expect(deps.calls.map(({ call }) => call)).toStrictEqual([{
      fn: 'radar', method: 'GET', path: '/radar/brands/acme', resource: '/radar/{proxy+}',
      pathParameters: { proxy: 'brands/acme' }, query: { days: 30 },
    }]);
  });

  it.each([['compare', { categories: [] }]])('reads the %s view', async (view, body) => {
    const deps = fakeDeps({ [`GET /radar/brands/acme/${view}`]: body });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'acme', view }, fakeContext());
    expect(JSON.parse(result.content)).toMatchObject(body);
  });

  it.each([
    [{ brand: '../users' }],
    [{ brand: 'acme', view: 'delete' }],
    [{ days: 400 }],
    [{ extra: true }],
    [{ view: 'reviews' }],
    [{ brand: 'acme', view: 'review' }],
    [{ brand: 'acme', view: 'summary', sentiment: 'positive' }],
    [{ brand: 'acme', view: 'reviews', feedback_id: 'f1' }],
    [{ brand: 'acme', view: 'reviews', limit: 51 }],
    [{ brand: 'acme', view: 'reviews', sentiment: 'angry' }],
    [{ brand: 'acme', view: 'reviews', day: '18/10/2026' }],
  ])('refuses %j before any invoke', async (input) => {
    const deps = fakeDeps({});
    await expect(serverTool(deps, 'get_radar').execute(input, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });

  it('lists the brand list (view brands) through the proxy resource', async () => {
    const deps = fakeDeps({ 'GET /radar/brands': { brands: [{ key: 'acme', origin: 'list' }] } });
    await serverTool(deps, 'get_radar').execute({ view: 'brands' }, fakeContext());
    expect(deps.calls.map(({ call }) => call)).toStrictEqual([{
      fn: 'radar', method: 'GET', path: '/radar/brands', resource: '/radar/{proxy+}', pathParameters: { proxy: 'brands' },
    }]);
  });

  it('reads filtered reviews with the REST route\u2019s query names, "" subcategory kept', async () => {
    const deps = fakeDeps({ 'GET /radar/brands/acme/reviews': { reviews: [], next_cursor: null } });
    const input = { brand: 'acme', view: 'reviews', days: 30, category: 'delivery', subcategory: '', sentiment: 'positive', day: '2026-10-01', cursor: 'abc', limit: 10 };
    await serverTool(deps, 'get_radar').execute(input, fakeContext());
    expect(deps.calls.map(({ call }) => call)).toStrictEqual([{
      fn: 'radar', method: 'GET', path: '/radar/brands/acme/reviews', resource: '/radar/{proxy+}',
      pathParameters: { proxy: 'brands/acme/reviews' },
      query: { days: 30, category: 'delivery', subcategory: '', sentiment: 'positive', day: '2026-10-01', cursor: 'abc', limit: 10 },
    }]);
  });

  it('reads one review by feedback_id', async () => {
    const deps = fakeDeps({ 'GET /radar/brands/acme/reviews/fb_1': { brand: { key: 'acme' }, review: { feedback_id: 'fb_1' } } });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'acme', view: 'review', feedback_id: 'fb_1' }, fakeContext());
    expect(deps.calls.map(({ call }) => call.pathParameters)).toStrictEqual([{ proxy: 'brands/acme/reviews/fb_1' }]);
    expect(JSON.parse(result.content)).toStrictEqual({ brand: { key: 'acme' }, review: { feedback_id: 'fb_1' } });
  });
});
