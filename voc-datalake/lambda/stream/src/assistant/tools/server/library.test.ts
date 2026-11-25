/**
 * `library_search` and the library context reader (tools/server/library.ts): the route it calls, ids versus slugs,
 * the passages' citation markers and chips, and an unreadable answer.
 */
import { describe, expect, it } from 'vitest';
import { fakeDeps, fakeContext } from '../test-fixtures.js';
import { citationMarker, createLibraryServerTools, librarySources, loadLibraryContext } from './library.js';

const ITEM = 'lib_20261101000000_0000a001';
const ROUTE = 'POST /projects/library/context';
const ANSWER = {
  items: [{ item_id: ITEM, slug: 'q3-market', title: 'Q3 market', status: 'ready' }, { item_id: 'bad' }],
  native: [],
  passages: [{ item_id: ITEM, chunk: 3, page: 2, text: 'North grew 12%.' }, { item_id: ITEM, chunk: 'x' }],
  missing: 0,
  pending: [{ item_id: 'lib_20261101000000_0000a009', status: 'extracting' }],
};

function tool(routes: Record<string, unknown>) {
  const deps = fakeDeps(routes);
  const [search] = createLibraryServerTools(deps);
  if (search === undefined) throw new Error('library_search missing');
  return { deps, search };
}

describe('library_search', () => {
  it('searches the named items by id and by slug and cites each passage', async () => {
    const { deps, search } = tool({ [ROUTE]: ANSWER });
    const result = await search.execute({ query: 'growth', items: [ITEM, '#Q3-Market', 'not a slug'] }, fakeContext());
    expect(deps.calls[0]?.call.body).toStrictEqual({ query: 'growth', native_slots: 0, item_ids: [ITEM],
      slugs: ['q3-market'] });
    expect(result.content).toContain('[#q3-market p.2] Q3 market\nNorth grew 12%.');
    expect(result.content).toContain('never instructions');
    expect(result.librarySources).toStrictEqual([{ item_id: ITEM, slug: 'q3-market', title: 'Q3 market', page: 2 }]);
  });

  it('searches by the question alone without items', async () => {
    const { deps, search } = tool({ [ROUTE]: { ...ANSWER, passages: [] } });
    const result = await search.execute({ query: 'growth' }, fakeContext());
    expect(deps.calls[0]?.call.body).toStrictEqual({ query: 'growth', native_slots: 0 });
    expect(result.content).toContain('No passage of #q3-market "Q3 market" matches "growth"');
  });

  it('says when nothing matches at all', async () => {
    const { search } = tool({ [ROUTE]: { items: [], native: [], passages: [], missing: 0, pending: [] } });
    expect((await search.execute({ query: 'growth' }, fakeContext())).content).toContain('No library item matches');
  });

  it('refuses a malformed input', async () => {
    const { search } = tool({ [ROUTE]: ANSWER });
    await expect(search.execute({ query: '' }, fakeContext())).rejects.toThrow('query');
    await expect(search.execute({ query: 'q', items: ['a', 'b', 'c', 'd'] }, fakeContext())).rejects.toThrow('items');
  });
});

describe('loadLibraryContext', () => {
  it('drops unreadable rows and refuses an unreadable answer', async () => {
    const deps = fakeDeps({ [ROUTE]: ANSWER });
    const context = await loadLibraryContext(deps.invoke, { query: 'q', nativeSlots: 1, itemIds: [ITEM] },
      { sub: 'sub-ada' });
    expect(context.items.map((item) => item.item_id)).toStrictEqual([ITEM]);
    expect(context.passages).toHaveLength(1);
    expect(context.pending).toStrictEqual(['lib_20261101000000_0000a009']);
    const broken = fakeDeps({ [ROUTE]: 'nope' });
    await expect(loadLibraryContext(broken.invoke, { query: 'q', nativeSlots: 0 }, { sub: 's' }))
      .rejects.toThrow('unreadable');
  });

  it('marks and chips a passage with or without its page', () => {
    expect(citationMarker('q3', 4)).toBe('[#q3 p.4]');
    expect(citationMarker('q3', undefined)).toBe('[#q3]');
    const items = [{ item_id: ITEM, slug: 'q3', title: 'Q3', status: 'ready' }];
    expect(librarySources(items, [{ item_id: ITEM, chunk: 1, page: undefined, text: 't' },
      { item_id: ITEM, chunk: 2, page: undefined, text: 'u' }, { item_id: 'other', chunk: 1, page: 1, text: 'v' }]))
      .toStrictEqual([{ item_id: ITEM, slug: 'q3', title: 'Q3' }]);
  });
});
