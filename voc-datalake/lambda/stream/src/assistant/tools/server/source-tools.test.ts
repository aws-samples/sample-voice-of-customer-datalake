import { describe, expect, it } from 'vitest';
import { fakeContext, fakeDeps, serverTool, UNSET_ROW } from '../test-fixtures.js';
import { RUN_SOURCE_IDS } from '../client/scraper-schemas.js';
import { androidCandidates, sourceRunView } from './source-tools.js';

/** Plugin ids that ship an ingestor handler (paths only; vitest resolves the glob). */
const INGESTOR_PLUGINS = Object.keys(import.meta.glob<string>('../../../../../../plugins/*/ingestor/handler.py', { eager: true, query: '?raw', import: 'default' }))
  .map((file) => file.split('/').at(-3) ?? '')
  .filter((name) => !name.startsWith('_'));
const byName = (a: string, b: string) => a.localeCompare(b);
const admin = fakeContext('scrapers', {}, { isAdmin: true });

describe('RUN_SOURCE_IDS', () => {
  it('names exactly the plugins with an ingestor, without the per-scraper webscraper', () => {
    expect(INGESTOR_PLUGINS).toContain('webscraper');
    expect([...RUN_SOURCE_IDS].sort(byName)).toStrictEqual(INGESTOR_PLUGINS.filter((name) => name !== 'webscraper').sort(byName));
  });
});

describe('get_source_run', () => {
  const row = { pk: 'SOURCE_RUN#app_reviews_ios', sk: 'run_1', status: 'completed', items_found: 12, errors: ['TimeoutError', 'https://x.example/secret?token=1'] };

  it('reads the named execution and redacts error text that is not an exception class', async () => {
    const reads: unknown[] = [];
    const deps = fakeDeps({}, { readSourceRun: (source, executionId) => { reads.push([source, executionId]); return Promise.resolve(row); } });
    const result = await serverTool(deps, 'get_source_run').execute({ source: 'app_reviews_ios', execution_id: 'run_1' }, admin);
    expect(reads).toStrictEqual([['app_reviews_ios', 'run_1']]);
    expect(JSON.parse(result.content)).toMatchObject({ status: 'completed', items_found: 12, error_count: 2, errors: ['TimeoutError', 'error details withheld'] });
    expect(result.content).not.toContain('secret');
  });

  it('refuses a non-administrator before reading', async () => {
    const deps = fakeDeps({}, { readSourceRun: () => Promise.reject(new Error('must not read')) });
    await expect(serverTool(deps, 'get_source_run').execute({ source: 'github_issues' }, fakeContext('scrapers')))
      .rejects.toMatchObject({ code: 'not_permitted' });
  });

  it('answers never_run for a source with no run and not_found for an unknown execution', async () => {
    const tool = serverTool(fakeDeps(), 'get_source_run');
    expect(JSON.parse((await tool.execute({ source: 'github_issues' }, admin)).content)).toStrictEqual({ source: 'github_issues', status: 'never_run' });
    await expect(tool.execute({ source: 'github_issues', execution_id: 'run_x' }, admin)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a source that cannot be run by hand', async () => {
    await expect(serverTool(fakeDeps(), 'get_source_run').execute({ source: 'webscraper' }, admin)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('views a row without counts or errors as zero of each', () => {
    expect(sourceRunView('s3_import', { sk: 'run_2', status: 'running' })).toMatchObject({ items_found: 0, error_count: 0, errors: [] });
    expect(sourceRunView('s3_import', UNSET_ROW.value)).toStrictEqual({ source: 's3_import', status: 'never_run' });
  });
});

describe('find_app_store_app', () => {
  const apple = [{ id: '1234567890', name: 'Example Air', developer: 'Example Air Group', url: 'https://apps.apple.com/app/id1234567890' }];

  it('returns the App Store candidates for iOS', async () => {
    const searched: unknown[] = [];
    const deps = fakeDeps({}, { searchAppStore: (term, country) => { searched.push([term, country]); return Promise.resolve(apple); } });
    const result = await serverTool(deps, 'find_app_store_app').execute({ name: 'Example Air', platforms: ['ios'], country: 'cl' }, fakeContext());
    expect(searched).toStrictEqual([['Example Air', 'cl']]);
    expect(JSON.parse(result.content)).toStrictEqual({ candidates: [{ platform: 'ios', ...apple[0] }] });
  });

  it('extracts Play package names from web results when web search is on', async () => {
    const deps = fakeDeps({}, { webSearch: () => Promise.resolve({ content: '', webSources: [{ title: 'Example Air - Apps on Google Play', url: 'https://play.google.com/store/apps/details?id=com.example.air&hl=en', text: '', published_date: '' }] }) });
    const ctx = fakeContext('scrapers', {}, { props: { page: { kind: 'scrapers', path: '/' }, useWebSearch: true } });
    const result = await serverTool(deps, 'find_app_store_app').execute({ name: 'Example Air', platforms: ['android'] }, ctx);
    expect(JSON.parse(result.content)).toMatchObject({ candidates: [{ platform: 'android', id: 'com.example.air' }] });
  });

  it('asks for the package name instead of searching when web search is off', async () => {
    const deps = fakeDeps({}, { webSearch: () => Promise.reject(new Error('must not search')) });
    const result = await serverTool(deps, 'find_app_store_app').execute({ name: 'Example Air', platforms: ['android'] }, fakeContext());
    expect(JSON.parse(result.content)).toMatchObject({ candidates: [], note: expect.stringContaining('package name') });
  });

  it('keeps each package once, in first-seen order, from links and text', () => {
    const found = androidCandidates([{ title: 'A', url: 'https://play.google.com/store/apps/details?id=com.a.one' }], 'see play.google.com/store/apps/details?id=com.b.two and play.google.com/store/apps/details?id=com.a.one');
    expect(found.map((candidate) => candidate.id)).toStrictEqual(['com.a.one', 'com.b.two']);
  });
});
