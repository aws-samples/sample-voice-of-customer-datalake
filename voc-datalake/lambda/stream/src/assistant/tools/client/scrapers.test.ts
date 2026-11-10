/**
 * Connector write tools (create_scraper, update_scraper, create_app_connector):
 * argument bounds (mirroring scrapers_handler / integrations_handler), admin
 * gating, and the existing-id prechecks that run before an approval card.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_ONLY_CLIENT_TOOLS, ADMIN_ONLY_SERVER_TOOLS } from '../../contract.js';
import { buildCatalogue } from '../catalogue.js';
import { selectToolset } from '../registry.js';
import { fakeContext, fakeDeps, type FakeDeps } from '../test-fixtures.js';
import { ServiceError } from '../../../lib/errors.js';
import type { ClientToolDefinition } from '../../types.js';
import { SCRAPER_LIMITS, publicUrlProblem } from './scraper-schemas.js';

const admin = fakeContext('scrapers', {}, { isAdmin: true });
const user = fakeContext('scrapers');
const BASE = { id: 'acme', name: 'Acme', extraction_method: 'jsonld', base_url: 'https://www.acme.example/reviews' };
const CSS = { ...BASE, extraction_method: 'css', container_selector: '.review', text_selector: '.body' };
const IOS = { source: 'app_reviews_ios', app_name: 'Acme app', app_id: '123456789' };
const ANDROID = { source: 'app_reviews_android', app_name: 'Acme app', package_name: 'com.acme.app' };
const WEB = { source: 'web_reviews', app_name: 'Acme Trustpilot', url: 'https://www.trustpilot.com/review/acme.example' };

function toolOf(name: string, routes: Record<string, unknown> = {}, deps: FakeDeps = fakeDeps(routes)): ClientToolDefinition {
  const found = buildCatalogue(deps).find((tool) => tool.name === name);
  if (found?.kind !== 'client') throw new ServiceError(`no client tool ${name}`);
  return found;
}

const valid = (name: string, args: Record<string, unknown>) => toolOf(name).validate(args, admin).ok;
const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://www.acme.example/p/${i}`);

describe('create_scraper argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['the minimal jsonld scraper', BASE, true],
    ['a css scraper with both selectors', CSS, true],
    ['urls only (no base_url)', { ...BASE, base_url: undefined, urls: urls(2) }, true],
    ['25 urls', { ...BASE, urls: urls(SCRAPER_LIMITS.maxUrls) }, true],
    ['26 urls', { ...BASE, urls: urls(SCRAPER_LIMITS.maxUrls + 1) }, false],
    ['no URL at all', { ...BASE, base_url: undefined }, false],
    ['css without a text selector', { ...CSS, text_selector: undefined }, false],
    ['an unknown method', { ...BASE, extraction_method: 'xpath' }, false],
    ['an id with a slash', { ...BASE, id: 'a/b' }, false],
    ['a 64-char id', { ...BASE, id: 'a'.repeat(64) }, true],
    ['a 65-char id', { ...BASE, id: 'a'.repeat(65) }, false],
    ['a 500-char selector', { ...CSS, title_selector: 'x'.repeat(500) }, true],
    ['a 501-char selector', { ...CSS, title_selector: 'x'.repeat(501) }, false],
    ['frequency 43200', { ...BASE, frequency_minutes: 43_200 }, true],
    ['frequency 43201', { ...BASE, frequency_minutes: 43_201 }, false],
    ['a negative frequency', { ...BASE, frequency_minutes: -1 }, false],
    ['a fractional frequency', { ...BASE, frequency_minutes: 1.5 }, false],
    ['"enabled" as a string', { ...BASE, enabled: 'true' }, false],
    ['pagination 50 pages from 10000', { ...BASE, pagination: { enabled: true, param: 'page', max_pages: 50, start: 10_000 } }, true],
    ['pagination 51 pages', { ...BASE, pagination: { enabled: true, max_pages: 51 } }, false],
    ['pagination start 10001', { ...BASE, pagination: { enabled: true, start: 10_001 } }, false],
    ['a 65-char pagination param', { ...BASE, pagination: { enabled: true, param: 'p'.repeat(65) } }, false],
    ['an unknown pagination key', { ...BASE, pagination: { enabled: true, step: 2 } }, false],
    ['dimension defaults and tags', { ...BASE, dimension_defaults: { product: 'mobile' }, tags: ['web'] }, true],
    ['11 dimension defaults', { ...BASE, dimension_defaults: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v'])) }, false],
    ['21 tags', { ...BASE, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, false],
    ['a header field (not a scraper arg)', { ...BASE, headers: { Cookie: 'x' } }, false],
    ['a config over 8 KiB', { ...BASE, urls: urls(25).map((u) => `${u}?q=${'x'.repeat(400)}`) }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('create_scraper', args)).toBe(expected);
  });
});

describe('the public-URL rule (the route re-checks with DNS)', () => {
  it.each([
    ['http://www.acme.example/', 'must use https'],
    ['https://localhost/x', 'must not point at localhost'],
    ['https://api.localhost/x', 'must not point at localhost'],
    ['https://10.0.0.1/x', 'must use a host name, not an IP address'],
    ['https://2130706433/x', 'must use a host name, not an IP address'],
    ['https://[::1]/x', 'must use a host name, not an IP address'],
    ['https://user:pw@www.acme.example/', 'must not embed credentials'],
    ['https://intranet/x', 'must use a fully qualified public host name'],
    ['www.acme.example/reviews', 'must be an absolute URL'],
  ])('%s is refused: %s', (url, problem) => {
    expect(publicUrlProblem(url)).toBe(problem);
  });

  it('accepts a public https URL and refuses one over 2048 characters', () => {
    expect(publicUrlProblem('https://www.acme.example/reviews?page=2')).toBeUndefined();
    expect(valid('create_scraper', { ...BASE, base_url: `https://www.acme.example/${'x'.repeat(2048)}` })).toBe(false);
  });
});

describe('update_scraper argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['one changed field', { scraper_id: 'scraper_1', updates: { frequency_minutes: 60 } }, true],
    ['clearing an optional selector', { scraper_id: 'scraper_1', updates: { title_selector: '' } }, true],
    ['empty updates', { scraper_id: 'scraper_1', updates: {} }, false],
    ['an id inside updates', { scraper_id: 'scraper_1', updates: { id: 'other' } }, false],
    ['an unknown key inside updates', { scraper_id: 'scraper_1', updates: { cookies: 'x' } }, false],
    ['a private URL inside updates', { scraper_id: 'scraper_1', updates: { base_url: 'https://192.168.1.1/' } }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('update_scraper', args)).toBe(expected);
  });
});

describe('create_app_connector argument bounds', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['an iOS app', IOS, true],
    ['an Android app sorted by rating', { ...ANDROID, sort_by: 'rating', frequency_minutes: 1440, max_reviews_per_run: 5000 }, true],
    ['iOS without app_id', { ...IOS, app_id: undefined }, false],
    ['iOS with a package name', { ...IOS, package_name: 'com.acme.app' }, false],
    ['Android without package_name', { ...ANDROID, package_name: undefined }, false],
    ['Android with an iOS sort order', { ...ANDROID, sort_by: 'most_recent' }, false],
    ['a non-numeric App Store id', { ...IOS, app_id: 'id123456789' }, false],
    ['a one-segment package name', { ...ANDROID, package_name: 'acme' }, false],
    ['a frequency not in the manifest', { ...IOS, frequency_minutes: 45 }, false],
    ['5001 reviews per run', { ...IOS, max_reviews_per_run: 5001 }, false],
    ['an unknown source', { ...IOS, source: 'app_reviews_web' }, false],
    ['an app name with a slash', { ...IOS, app_name: 'a/b' }, false],
    ['a web review page', { ...WEB, max_pages: 100, frequency_minutes: 1440 }, true],
    ['web_reviews: all pages, the latest 200 reviews', { ...WEB, max_pages: 0, max_reviews: 200 }, true],
    ['web_reviews: everything', { ...WEB, max_pages: 0, max_reviews: 0 }, true],
    ['web_reviews with 5000 reviews', { ...WEB, max_reviews: 5000 }, true],
    ['web_reviews with 5001 reviews', { ...WEB, max_reviews: 5001 }, false],
    ['web_reviews with -1 reviews', { ...WEB, max_reviews: -1 }, false],
    ['web_reviews with 1.5 reviews', { ...WEB, max_reviews: 1.5 }, false],
    ['web_reviews without url', { ...WEB, url: undefined }, false],
    ['web_reviews over plain http', { ...WEB, url: WEB.url.replace('https:', 'http:') }, false],
    ['web_reviews at an IP address', { ...WEB, url: 'https://10.0.0.1/reviews' }, false],
    ['web_reviews with 101 pages', { ...WEB, max_pages: 101 }, false],
    ['web_reviews with -1 pages', { ...WEB, max_pages: -1 }, false],
    ['web_reviews with an App Store id', { ...WEB, app_id: '1' }, false],
    ['web_reviews with a review cap', { ...WEB, max_reviews_per_run: 10 }, false],
    ['iOS with a url', { ...IOS, url: WEB.url }, false],
    ['iOS with max_pages', { ...IOS, max_pages: 2 }, false],
    ['iOS with max_reviews', { ...IOS, max_reviews: 2 }, false],
  ])('%s → %s', (_label, args, expected) => {
    expect(valid('create_app_connector', args)).toBe(expected);
  });
});

describe('admin gating', () => {
  it.each(['create_scraper', 'update_scraper', 'create_app_connector'])('%s is admin-only and refused for a non-admin', (name) => {
    expect(ADMIN_ONLY_CLIENT_TOOLS).toContain(name);
    expect(toolOf(name).validate(BASE, user)).toStrictEqual({ ok: false, error: `${name} is only available to administrators.` });
  });

  it('a non-admin on the Scrapers page is not offered the connector tools or analyze_scraper_url', () => {
    const offered = (isAdmin: boolean) => selectToolset(buildCatalogue(fakeDeps()), { page: user.page, isAdmin, webSearch: false })
      .tools.map((tool) => tool.name).filter((name) => name !== 'web_search');
    const connector = ['analyze_scraper_url', 'create_scraper', 'update_scraper', 'create_app_connector'];
    expect(offered(true)).toStrictEqual(expect.arrayContaining(connector));
    expect(offered(false).filter((name) => connector.includes(name))).toStrictEqual([]);
  });

  it('keeps analyze_scraper_url out of a non-admin toolset even when the thread tail names it', () => {
    const toolset = selectToolset(buildCatalogue(fakeDeps()), { page: user.page, isAdmin: false, webSearch: false, alsoInclude: ['analyze_scraper_url'] });
    expect(ADMIN_ONLY_SERVER_TOOLS).toStrictEqual(['analyze_scraper_url', 'list_users', 'get_user_access', 'get_source_run']);
    expect(toolset.byName.has('analyze_scraper_url')).toBe(false);
  });
});

describe('prechecks against GET /scrapers (before any card)', () => {
  const stored = { 'GET /scrapers': { scrapers: [{ id: 'acme', name: 'Acme' }, { name: 'no id' }] } };

  it('refuses a create whose id already exists — a create never overwrites', async () => {
    const refusal = await toolOf('create_scraper', stored).precheck?.(BASE, admin);
    expect(refusal).toBe('a scraper with id "acme" already exists. Pick another id, or propose update_scraper to change it.');
  });

  it('lets a create with a new id through', async () => {
    expect(await toolOf('create_scraper', stored).precheck?.({ ...BASE, id: 'acme_2' }, admin)).toBeUndefined();
  });

  it('refuses an update of an id no scraper has, and passes an existing one', async () => {
    const tool = toolOf('update_scraper', stored);
    expect(await tool.precheck?.({ scraper_id: 'ghost', updates: { name: 'x' } }, admin))
      .toBe('no scraper has id "ghost". Read list_scrapers; to add one, propose create_scraper.');
    expect(await tool.precheck?.({ scraper_id: 'acme', updates: { name: 'x' } }, admin)).toBeUndefined();
  });

  it('reads the list as the caller', async () => {
    const deps = fakeDeps(stored);
    await toolOf('create_scraper', {}, deps).precheck?.(BASE, admin);
    expect(deps.calls).toStrictEqual([{ call: { fn: 'scrapers', method: 'GET', path: '/scrapers', resource: '/scrapers' }, sub: 'user-sub' }]);
  });
});
