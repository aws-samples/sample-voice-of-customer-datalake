/**
 * Mutation pins for the memory server tools (`search_memory`, `get_memory_review`).
 *
 * The Stryker run found what the behaviour suite could not see: the exact
 * Bedrock specs the model reads (names, descriptions, enums, bounds), the exact
 * call each tool makes (resource, query keys), the 25-row cap per scope on both
 * sides of the boundary, the "more" flag's cursor rules (empty, non-string,
 * absent body), the conflict prompt's presence only when something conflicts,
 * and every input refusal (strict keys, enums, the trimmed 1..500 statement).
 */
import { describe, expect, it } from 'vitest';
import type { ServerToolDefinition } from '../../types.js';
import { fakeContext, fakeDeps, type FakeDeps } from '../test-fixtures.js';
import { createMemoryServerTools } from './memory.js';

const NEXT_PROMPT = 'Ask the user: "<supporters> people said <statement> — is it now <their statement>? '
  + 'Update it for everyone?" before proposing update_company_memory.';

function tools(deps: FakeDeps): { search: ServerToolDefinition; review: ServerToolDefinition } {
  const [search, review, ...rest] = createMemoryServerTools(deps);
  if (!search || !review || rest.length > 0) throw new TypeError('expected exactly two memory tools');
  return { search, review };
}

/** Rows holding only fields summarizeMemories keeps, so a row is also its own summary. */
function rows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ memory_id: `m${i}`, statement: `s${i}` }));
}

describe('the memory tool definitions', () => {
  it('builds search_memory (core) then get_memory_review (memory pack) with their exact specs', () => {
    const { search, review } = tools(fakeDeps());
    expect([search.kind, search.name, search.pack, review.kind, review.name, review.pack])
      .toStrictEqual(['server', 'search_memory', 'core', 'server', 'get_memory_review', 'memory']);
    expect(search.spec).toStrictEqual({
      toolSpec: {
        name: 'search_memory',
        description: 'Look up what this workspace remembers. mode "search" (default) lists memories — company ones (shared by '
          + 'everyone) and the user\u2019s own personal ones — optionally filtered by text, scope, kind and status; '
          + 'supporters = how many people said it. mode "conflicts" checks a NEW statement (in query) against active '
          + 'company memories and returns the ones it contradicts, with their supporter counts.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['search', 'conflicts'], description: 'search (default) or conflicts.' },
              query: { type: 'string', maxLength: 500, description: 'Text to match; for conflicts, the new statement.' },
              scope: { type: 'string', enum: ['company', 'personal'], description: 'Only company or only personal (default both).' },
              kind: {
                type: 'string',
                enum: ['product', 'customer', 'agents', 'working_style', 'strategy', 'objective', 'other'],
                description: 'Only this kind.',
              },
              status: {
                type: 'string',
                enum: ['active', 'proposed', 'conflict', 'archived'],
                description: 'Only this status (default: as the API lists).',
              },
            },
            required: [],
            additionalProperties: false,
          },
        },
      },
    });
    expect(review.spec).toStrictEqual({
      toolSpec: {
        name: 'get_memory_review',
        description: 'The memory review queue (administrators and memory reviewers): proposed company memories and conflicts side '
          + 'by side, with supporter counts, alignment with company objectives and a suggested resolution. Use it before '
          + 'proposing resolve_memory_conflict or merge_memories.',
        inputSchema: { json: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      },
    });
  });
});

describe('search_memory lists each scope as the caller', () => {
  it('sends the exact call per scope, with the trimmed query and every filter', async () => {
    const deps = fakeDeps({ 'GET /memory': { items: [] } });
    const result = await tools(deps).search.execute(
      { mode: 'search', query: '  SSO  ', kind: 'product', status: 'active' },
      fakeContext(),
    );
    expect(deps.calls).toStrictEqual(['company', 'personal'].map((scope) => ({
      call: {
        fn: 'memory', method: 'GET', path: '/memory', resource: '/memory',
        query: { scope, q: 'SSO', kind: 'product', status: 'active' },
      },
      sub: 'user-sub',
    })));
    expect(result).toStrictEqual({
      content: '{"results":[{"scope":"company","returned":0,"items":[]},{"scope":"personal","returned":0,"items":[]}]}',
    });
  });

  it('lists without a query when none is given (mode defaults to search)', async () => {
    const deps = fakeDeps({ 'GET /memory': { items: [] } });
    await tools(deps).search.execute({ scope: 'company' }, fakeContext());
    expect(deps.calls.map((c) => c.call.query)).toStrictEqual([
      { scope: 'company', q: undefined, kind: undefined, status: undefined },
    ]);
  });

  it('a query without mode "conflicts" is a search, not a conflict check', async () => {
    const deps = fakeDeps({ 'GET /memory': { items: [] } });
    await tools(deps).search.execute({ query: 'SSO', scope: 'personal' }, fakeContext());
    expect(deps.calls.map((c) => c.call.path)).toStrictEqual(['/memory']);
  });
});

describe('search_memory caps each scope at 25 rows', () => {
  it.each([
    [25, { scope: 'personal', returned: 25, items: rows(25) }],
    [26, { scope: 'personal', returned: 25, more: true, items: rows(25) }],
  ])('%i rows without a cursor', async (count, expected) => {
    const deps = fakeDeps({ 'GET /memory': { items: rows(count) } });
    const result = await tools(deps).search.execute({ scope: 'personal' }, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({ results: [expected] });
  });
});

describe('search_memory says "more" only for a real cursor', () => {
  it.each([
    ['a non-empty string cursor', { items: rows(1), next_cursor: 'c2' }, { scope: 'company', returned: 1, more: true, items: rows(1) }],
    ['an empty cursor', { items: rows(1), next_cursor: '' }, { scope: 'company', returned: 1, items: rows(1) }],
    ['a non-string cursor', { items: rows(1), next_cursor: 7 }, { scope: 'company', returned: 1, items: rows(1) }],
    ['a null body', null, { scope: 'company', returned: 0, items: [] }],
  ])('%s', async (_label, body, expected) => {
    const deps = fakeDeps({ 'GET /memory': body });
    const result = await tools(deps).search.execute({ scope: 'company' }, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({ results: [expected] });
  });
});

describe('search_memory mode "conflicts"', () => {
  it('asks the N-people question only when something conflicts', async () => {
    const deps = fakeDeps({ 'GET /memory/conflict-check': { conflicts: [{ memory_id: 'm1', statement: 'Old', supporters: 3 }] } });
    const result = await tools(deps).search.execute({ mode: 'conflicts', query: ' New ' }, fakeContext());
    expect(deps.calls).toStrictEqual([{
      call: {
        fn: 'memory', method: 'GET', path: '/memory/conflict-check', resource: '/memory/conflict-check',
        query: { statement: 'New' },
      },
      sub: 'user-sub',
    }]);
    expect(JSON.parse(result.content)).toStrictEqual({
      statement: 'New',
      count: 1,
      conflicts: [{ memory_id: 'm1', statement: 'Old', supporters: 3 }],
      next: NEXT_PROMPT,
    });
  });

  it('returns no prompt when nothing conflicts', async () => {
    const deps = fakeDeps({ 'GET /memory/conflict-check': { conflicts: [] } });
    const result = await tools(deps).search.execute({ mode: 'conflicts', query: 'New' }, fakeContext());
    expect(result).toStrictEqual({ content: '{"statement":"New","count":0,"conflicts":[]}' });
  });
});

describe('search_memory refuses bad input before any call', () => {
  it.each([
    ['conflicts without a statement', { mode: 'conflicts' }, 'Invalid arguments — query: mode "conflicts" needs the new statement in query'],
    ['an unknown key', { mode: 'search', extra: 1 }, 'Invalid arguments — Unrecognized key: "extra"'],
  ])('%s', async (_label, input, message) => {
    const deps = fakeDeps();
    await expect(tools(deps).search.execute(input, fakeContext())).rejects.toMatchObject({ code: 'invalid_input', message });
    expect(deps.calls).toStrictEqual([]);
  });

  it.each([
    ['an unknown mode', { mode: 'list' }],
    ['an unknown scope', { scope: 'team' }],
    ['an unknown kind', { kind: 'misc' }],
    ['an unknown status', { status: 'deleted' }],
    ['a blank query', { query: '   ' }],
    ['a 501-character query', { query: 'x'.repeat(501) }],
  ])('%s', async (_label, input) => {
    const deps = fakeDeps();
    await expect(tools(deps).search.execute(input, fakeContext())).rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });

  it('accepts a 500-character query', async () => {
    const deps = fakeDeps({ 'GET /memory': { items: [] } });
    await tools(deps).search.execute({ query: 'x'.repeat(500), scope: 'company' }, fakeContext());
    expect(deps.calls.map((c) => c.call.query?.q)).toStrictEqual(['x'.repeat(500)]);
  });
});

describe('get_memory_review', () => {
  it('reads /memory/review as the caller and returns the scrubbed body', async () => {
    const deps = fakeDeps({ 'GET /memory/review': { items: [{ kind: 'conflict', pk: 'MEM#company' }] } });
    const result = await tools(deps).review.execute({}, fakeContext('memory'));
    expect(deps.calls).toStrictEqual([{
      call: { fn: 'memory', method: 'GET', path: '/memory/review', resource: '/memory/review' },
      sub: 'user-sub',
    }]);
    expect(result).toStrictEqual({ content: '{"items":[{"kind":"conflict"}]}' });
  });

  it('refuses any argument', async () => {
    const deps = fakeDeps();
    await expect(tools(deps).review.execute({ status: 'proposed' }, fakeContext('memory')))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(deps.calls).toStrictEqual([]);
  });
});
