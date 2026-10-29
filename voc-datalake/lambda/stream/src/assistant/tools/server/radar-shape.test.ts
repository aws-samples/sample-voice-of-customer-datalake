/**
 * Wave 4 (live verification of 3d9fc79): a Radar answer listed bare URLs with
 * "(example-air.example)" suffixes, mixed http/https and www, and get_radar was called
 * four times for one question. These pin the shaping that fixes it.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { BRANDS_NOTE, COMPARE_NOTE, httpsUrl, shapeBrands, shapeCompare, shapeReleases, shortDate } from './radar-shape.js';

const NOW = Date.UTC(2026, 9, 20);
/** A clear-text link as the Radar API may return it (the shaping upgrades it). */
const PLAIN = ['http', '://'].join('');

const RELEASES = {
  brand: { key: 'example-air' },
  days: 365,
  releases: [
    { feature: 'Coding sessions', release_date: '2026-06-11', urls: ['https://example-air.example/changelog/2026-06-11-coding-sessions'], titles: ['example-air.example'] },
    { feature: 'Agent updates', release_date: '2026-06-18', date_approximate: true, urls: [`${PLAIN}www.example-air.example/changelog/2026-06-18-agent`, 'https://news.example/example-air-agent'], titles: ['www.example-air.example', 'Example Air ships [agent] updates'] },
    { feature: 'Duplicate', release_date: '2025-12-01', urls: ['https://www.example-air.example/changelog/2026-06-11-coding-sessions/'], titles: [''] },
  ],
};

describe('radar result shaping', () => {
  it('turns release URLs into titled https markdown links, deduped, with no raw url arrays', () => {
    const shaped = shapeReleases(RELEASES, NOW);
    expect(shaped).toMatchObject({ releases: [
      { feature: 'Coding sessions', links: ['[Coding sessions · Jun 11](https://example-air.example/changelog/2026-06-11-coding-sessions)'] },
      { links: ['[Agent updates · first found Jun 18](https://www.example-air.example/changelog/2026-06-18-agent)', '[Example Air ships agent updates](https://news.example/example-air-agent)'] },
      { links: [] },
    ] });
    expect(JSON.stringify(shaped)).not.toMatch(/"urls"|"titles"|http:\/\/|\(example-air\.app\)/u);
  });

  it('keeps each item\u2019s kind and found_via', () => {
    const shaped = shapeReleases({ releases: [{ feature: 'Spring promo', kind: 'promotion', found_via: ['feed', 'exa'], urls: [], titles: [] }] }, NOW);
    expect(shaped).toMatchObject({ releases: [{ kind: 'promotion', found_via: ['feed', 'exa'], links: [] }] });
  });

  it('upgrades http, refuses non-web schemes and dates another year in full', () => {
    expect([httpsUrl(`${PLAIN}a.example/x#frag`), httpsUrl('javascript:alert(1)'), httpsUrl(42)])
      .toStrictEqual(['https://a.example/x', undefined, undefined]);
    expect([shortDate('2025-12-01', false, 2026), shortDate('nope', false, 2026)]).toStrictEqual(['Dec 1, 2025', undefined]);
  });

  it('flags a compare row with fewer than 10 of their reviews and adds the reading note', () => {
    const shaped = shapeCompare({ categories: [
      { category: 'pricing', theirs: { volume: 4 } },
      { category: 'support', theirs: { volume: 12 } },
    ] });
    expect(shaped).toStrictEqual({ note: COMPARE_NOTE, categories: [
      { category: 'pricing', theirs: { volume: 4 }, small_sample: true },
      { category: 'support', theirs: { volume: 12 } },
    ] });
  });
});

describe('get_radar overview', () => {
  const routes = {
    'GET /radar/brands/example-air': { brand: { key: 'example-air' }, total: 12 },
    'GET /radar/brands/example-air/releases': RELEASES,
    'GET /radar/brands/example-air/compare': { categories: [{ category: 'pricing', theirs: { volume: 2 } }] },
  };

  it('answers a brand question in ONE tool call: summary, shaped releases and compare together', async () => {
    const deps = fakeDeps(routes, { nowMs: () => NOW });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'example-air', days: 90 }, fakeContext());
    expect(deps.calls.filter(({ call }) => call.fn === 'radar').map(({ call }) => call.pathParameters)).toStrictEqual([
      { proxy: 'brands/example-air' }, { proxy: 'brands/example-air/releases' }, { proxy: 'brands/example-air/compare' },
    ]);
    const body: unknown = JSON.parse(result.content);
    expect(body).toMatchObject({
      summary: { total: 12 },
      releases: { releases: [{ links: ['[Coding sessions · Jun 11](https://example-air.example/changelog/2026-06-11-coding-sessions)'] }, {}, {}] },
      compare: { categories: [{ small_sample: true }], note: COMPARE_NOTE },
    });
    expect(result.content).not.toContain('"urls"');
  });

  it('still lets the model drill into one view', async () => {
    const deps = fakeDeps(routes, { nowMs: () => NOW });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'example-air', view: 'releases' }, fakeContext());
    expect(deps.calls.filter(({ call }) => call.fn === 'radar')).toHaveLength(1);
    expect(result.content).toContain('[Coding sessions · Jun 11](https://example-air.example/');
  });
});

/**
 * A live run: after 18 create_app_connector calls with radar_brand, the assistant read view "brands", saw
 * `sources: []` for every brand and told the user the connectors were "not linked yet" and imports were "still
 * running". `sources` only ever lists source PROFILES; connectors never appear there.
 */
describe('shapeBrands', () => {
  it('renames each brand\u2019s source-profile ids to profile_sources and adds the reading note', () => {
    const body = { brands: [{ key: 'acme', label: 'Acme', domains: ['acme.example'], sources: [], origin: 'list' },
      { key: 'beta', label: 'Beta', domains: [], sources: ['beta_profile'], origin: 'profile' }] };
    expect(shapeBrands(body)).toStrictEqual({
      brands: [{ key: 'acme', label: 'Acme', domains: ['acme.example'], profile_sources: [], origin: 'list' },
        { key: 'beta', label: 'Beta', domains: [], profile_sources: ['beta_profile'], origin: 'profile' }],
      note: BRANDS_NOTE,
    });
  });

  it('says an empty profile_sources does not mean a brand has no source', () => {
    expect(BRANDS_NOTE).toContain('never appear there, so an empty list does not mean a brand has no source');
    expect(BRANDS_NOTE).toContain('list_scrapers lists every scraper, app connector and review page with the radar_brand it feeds');
  });

  it('leaves a list whose brands carry no sources, and a body without a brand list, unchanged', () => {
    expect(shapeBrands({ brands: [{ key: 'acme' }] })).toStrictEqual({ brands: [{ key: 'acme' }] });
    expect(shapeBrands({ error: 'nope' })).toStrictEqual({ error: 'nope' });
    expect(shapeBrands(null)).toBeNull();
  });

  it('reaches the model through get_radar view brands', async () => {
    const deps = fakeDeps({ 'GET /radar/brands': { brands: [{ key: 'acme', sources: [] }] } });
    const result = await serverTool(deps, 'get_radar').execute({ view: 'brands' }, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({ brands: [{ key: 'acme', profile_sources: [] }], note: BRANDS_NOTE });
  });

  it('reaches the model through get_radar without a brand (the tracked brands carry sources too)', async () => {
    const deps = fakeDeps({ 'GET /radar': { brands: [{ key: 'acme', sources: [], total: 0 }], last_scan: null } });
    const result = await serverTool(deps, 'get_radar').execute({}, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({
      brands: [{ key: 'acme', profile_sources: [], total: 0 }], last_scan: null, note: BRANDS_NOTE,
    });
  });

  it('leaves a brand\u2019s own summary unchanged (it has no brand list)', async () => {
    const deps = fakeDeps({ 'GET /radar/brands/acme': { brand: { key: 'acme' }, love: [] } });
    const result = await serverTool(deps, 'get_radar').execute({ brand: 'acme', view: 'summary' }, fakeContext());
    expect(JSON.parse(result.content)).toStrictEqual({ brand: { key: 'acme' }, love: [] });
  });
});
