import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';

const SLIM = {
  request_id: 'fr_1', board_id: 'brd_sales', title: 'Seat map in the app', description: 'Pick a seat before check-in',
  status: 'open', supporters: 12, category: 'booking', sentiment: 'negative', problem_summary: 'Cannot pick a seat early',
  created_at: '2026-05-01T10:00:00Z',
};
const ROUTE = 'GET /feature-requests/search';

describe('search_feature_requests', () => {
  it('reads GET /feature-requests/search through the proxy resource as the caller, default page 25', async () => {
    const deps = fakeDeps({ [ROUTE]: { success: true, items: [SLIM], total: 1, truncated: false } });
    const result = await serverTool(deps, 'search_feature_requests').execute({}, fakeContext());
    expect(deps.calls).toStrictEqual([{
      call: {
        fn: 'engagement', method: 'GET', path: '/feature-requests/search', resource: '/feature-requests/{proxy+}',
        pathParameters: { proxy: 'search' }, query: { limit: 25 },
      },
      sub: 'user-sub',
    }]);
    expect(JSON.parse(result.content)).toStrictEqual({ count: 1, total: 1, truncated: false, items: [SLIM] });
  });

  it('sends q, comma lists, a bounded window and the limit with the route\u2019s query names', async () => {
    const deps = fakeDeps({ [ROUTE]: { items: [] } });
    const input = { query: 'seat map', board: ['brd_sales', 'ideas'], category: 'booking', status: ['open', 'planned'], days: 90, limit: 50 };
    await serverTool(deps, 'search_feature_requests').execute(input, fakeContext());
    expect(deps.calls[0]?.call.query).toStrictEqual({
      limit: 50, q: 'seat map', board: 'brd_sales,ideas', category: 'booking', status: 'open,planned', days: 90,
    });
  });

  it('sends no days for all time (0)', async () => {
    const deps = fakeDeps({ [ROUTE]: { items: [] } });
    await serverTool(deps, 'search_feature_requests').execute({ days: 0 }, fakeContext());
    expect(deps.calls[0]?.call.query).toStrictEqual({ limit: 25 });
  });

  it('passes only the slim fields, clips long text and keeps the route\u2019s total and truncated', async () => {
    const item = { ...SLIM, description: 'x'.repeat(1500), email: 'someone@example.com', author_name: 'Someone', fields: { a: 1 } };
    const deps = fakeDeps({ [ROUTE]: { items: [item, 'not a record'], total: 340, truncated: true } });
    const content = (await serverTool(deps, 'search_feature_requests').execute({}, fakeContext())).content;
    const expected = { ...SLIM, description: `${'x'.repeat(1000)}…` };
    expect(JSON.parse(content)).toStrictEqual({ count: 1, total: 340, truncated: true, items: [expected] });
    expect(content).not.toContain('example.com');
  });

  it('counts the items when the route gives no total', async () => {
    const deps = fakeDeps({ [ROUTE]: { items: [SLIM, SLIM] } });
    const result = JSON.parse((await serverTool(deps, 'search_feature_requests').execute({}, fakeContext())).content);
    expect(result).toMatchObject({ count: 2, total: 2, truncated: false });
  });

  it.each([
    [{ limit: 51 }],
    [{ limit: 0 }],
    [{ days: 3651 }],
    [{ days: -1 }],
    [{ query: '' }],
    [{ board: 'a,b' }],
    [{ status: [] }],
    [{ category: Array.from({ length: 21 }, (_, i) => `c${i}`) }],
    [{ extra: true }],
  ])('refuses %j before any invoke', async (input) => {
    const deps = fakeDeps({});
    await expect(serverTool(deps, 'search_feature_requests').execute(input, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });

  it('tells the model these are board requests, not reviews, cited as [FR:<id>]', () => {
    const description = serverTool(fakeDeps(), 'search_feature_requests').spec.toolSpec?.description ?? '';
    expect(description).toContain('NOT customer reviews');
    expect(description).toContain('[FR:<request_id>]');
  });
});
