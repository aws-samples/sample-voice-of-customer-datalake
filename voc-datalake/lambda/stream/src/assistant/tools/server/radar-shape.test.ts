/**
 * Wave 4 (live verification of 3d9fc79): a Radar answer listed bare URLs with
 * "(example-air.example)" suffixes, mixed http/https and www, and get_radar was called
 * four times for one question. These pin the shaping that fixes it.
 */
import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool } from '../test-fixtures.js';
import { COMPARE_NOTE, httpsUrl, shapeCompare, shapeReleases, shortDate } from './radar-shape.js';

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
      { links: ['[Agent updates · about Jun 18](https://www.example-air.example/changelog/2026-06-18-agent)', '[Example Air ships agent updates](https://news.example/example-air-agent)'] },
      { links: [] },
    ] });
    expect(JSON.stringify(shaped)).not.toMatch(/"urls"|"titles"|http:\/\/|\(example-air\.app\)/u);
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
