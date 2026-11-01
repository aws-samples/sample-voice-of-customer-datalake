import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from './app-store-search.js';
import {
  IOS_STOREFRONTS, MAX_FAILED_STOREFRONTS, appStoreLookupUrl, lookupAppStoreApp, lookupPlayApp, lookupStoreApp, playAppUrl, playPageDetails,
} from './store-app-lookup.js';

const APP_ID = '1234567890';
const lookupBody = (found: boolean) => JSON.stringify({
  resultCount: found ? 1 : 0,
  results: found ? [{ trackId: Number(APP_ID), trackName: 'Example Air', sellerName: 'Example Air Group', trackViewUrl: `https://apps.apple.com/us/app/id${APP_ID}` }] : [],
});

/** A fetch that answers per storefront (`country` query parameter) and records every call. */
function storefronts(answer: (country: string) => Response | Error) {
  const calls: { url: URL; init: Parameters<FetchFn>[1] }[] = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    const reply = answer(url.searchParams.get('country') ?? '');
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { calls, fetchFn };
}

describe('IOS_STOREFRONTS', () => {
  it('are exactly the storefronts the iOS connector reads (countries.py), US first', () => {
    const source = readFileSync(join(__dirname, '../../../../plugins/app_reviews_ios/ingestor/countries.py'), 'utf8');
    const list = /IOS_COUNTRIES = \[([\s\S]*?)\]/.exec(source)?.[1] ?? '';
    expect([...IOS_STOREFRONTS]).toStrictEqual([...list.matchAll(/"([a-z]{2})"/g)].map((match) => match[1]));
    expect(IOS_STOREFRONTS[0]).toBe('us');
  });
});

describe('lookupAppStoreApp', () => {
  it('asks only the iTunes Lookup API for that id, without following redirects', () => {
    const url = appStoreLookupUrl(APP_ID, 'pl');
    expect(`${url.origin}${url.pathname}`).toBe('https://itunes.apple.com/lookup');
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({ id: APP_ID, country: 'pl', entity: 'software' });
  });

  it('returns the app with its developer after one US lookup when the US store has it', async () => {
    const { calls, fetchFn } = storefronts(() => new Response(lookupBody(true)));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({
      status: 'found', app: { name: 'Example Air', developer: 'Example Air Group' },
    });
    expect(calls.map((call) => call.url.searchParams.get('country'))).toStrictEqual(['us']);
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('finds an app sold only outside the US by asking the other storefronts, and stops after the hit', async () => {
    const { calls, fetchFn } = storefronts((country) => new Response(lookupBody(country === 'pl')));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toMatchObject({ status: 'found', app: { name: 'Example Air' } });
    const asked = calls.map((call) => call.url.searchParams.get('country'));
    expect(asked).toContain('pl');
    expect(asked.length).toBeLessThan(IOS_STOREFRONTS.length);
  });

  it('is missing only when every storefront answered without it', async () => {
    const { fetchFn } = storefronts(() => new Response(lookupBody(false)));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'missing' });
  });

  it('ignores a result for another id', async () => {
    const other = JSON.stringify({ results: [{ trackId: 1, trackName: 'Other', trackViewUrl: 'https://apps.apple.com/us/app/id1' }] });
    const { fetchFn } = storefronts(() => new Response(other));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'missing' });
  });

  it.each([
    ['the US store is unreachable', () => new Error('dns'), 'The App Store could not be reached'],
    ['the US store answers 503', () => new Response('', { status: 503 }), 'The App Store answered HTTP 503'],
    ['the US store answers HTML', () => new Response('<html>'), 'The App Store answered with something that is not JSON'],
  ])('is unknown, never missing, when %s', async (_label, reply, reason) => {
    const { calls, fetchFn } = storefronts(reply);
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'unknown', reason });
    expect(calls).toHaveLength(1);
  });

  it('stays missing when a few storefronts are throttled and every other one answered without the app', async () => {
    const { fetchFn } = storefronts((country) => (country === 'jp' ? new Response('', { status: 429 }) : new Response(lookupBody(false))));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'missing' });
  });

  it(`is unknown when more than ${MAX_FAILED_STOREFRONTS} storefronts fail`, async () => {
    const failing = new Set<string>(IOS_STOREFRONTS.slice(1, MAX_FAILED_STOREFRONTS + 2));
    const { fetchFn } = storefronts((country) => (failing.has(country) ? new Response('', { status: 429 }) : new Response(lookupBody(false))));
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'unknown', reason: 'The App Store answered HTTP 429' });
  });

  it('never has more than four storefront lookups in flight after a US miss', async () => {
    const live = { now: 0, peak: 0 };
    const fetchFn: FetchFn = async () => {
      live.now += 1;
      live.peak = Math.max(live.peak, live.now);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      live.now -= 1;
      return new Response(lookupBody(false));
    };
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toStrictEqual({ status: 'missing' });
    expect(live.peak).toBe(4);
  });

  it('stops asking, and cancels the lookups in flight, once one storefront has the app', async () => {
    const asked: string[] = [];
    const cancelled: string[] = [];
    const fetchFn: FetchFn = (url, init) => {
      const country = url.searchParams.get('country') ?? '';
      asked.push(country);
      if (country === 'us') return Promise.resolve(new Response(lookupBody(false)));
      if (country === 'gb') return Promise.resolve(new Response(lookupBody(true)));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => { cancelled.push(country); reject(new Error('aborted')); });
      });
    };
    await expect(lookupAppStoreApp(APP_ID, fetchFn)).resolves.toMatchObject({ status: 'found' });
    expect(asked).toStrictEqual(['us', 'gb', 'de', 'fr', 'jp']);
    expect(cancelled).toStrictEqual(['de', 'fr', 'jp']);
  });
});

const PLAY_PAGE = '<html><head><title>Example Air - Apps on Google Play</title></head><body>'
  + '<script type="application/ld+json" nonce="n">{"@context":"https://schema.org","@type":"SoftwareApplication",'
  + '"name":"Example Air","author":{"@type":"Person","name":"Example Air Group"}}</script></body></html>';

function playAnswering(reply: Response | Error) {
  const urls: URL[] = [];
  const fetchFn: FetchFn = (url) => {
    urls.push(url);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { urls, fetchFn };
}

describe('lookupPlayApp', () => {
  it('reads only the Play app page of that package', () => {
    const url = playAppUrl('com.example.air');
    expect(`${url.origin}${url.pathname}`).toBe('https://play.google.com/store/apps/details');
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({ id: 'com.example.air', hl: 'en', gl: 'us' });
  });

  it('returns the name and developer from the page\u2019s SoftwareApplication block', async () => {
    const { fetchFn } = playAnswering(new Response(PLAY_PAGE));
    await expect(lookupPlayApp('com.example.air', fetchFn)).resolves.toStrictEqual({
      status: 'found',
      app: { name: 'Example Air', developer: 'Example Air Group' },
    });
  });

  it('is found without details when the page has no SoftwareApplication block', async () => {
    const { fetchFn } = playAnswering(new Response('<html><script type="application/ld+json">not json</script></html>'));
    await expect(lookupPlayApp('com.example.air', fetchFn)).resolves.toMatchObject({ status: 'found', app: { name: '', developer: '' } });
  });

  it('is missing when Google Play answers 404', async () => {
    const { fetchFn } = playAnswering(new Response('', { status: 404 }));
    await expect(lookupPlayApp('com.example.invented', fetchFn)).resolves.toStrictEqual({ status: 'missing' });
  });

  it.each([
    ['unreachable', new Error('dns'), 'Google Play could not be reached'],
    ['a 429', new Response('', { status: 429 }), 'Google Play answered HTTP 429'],
    ['a 500', new Response('', { status: 500 }), 'Google Play answered HTTP 500'],
  ])('is unknown, never missing, on %s', async (_label, reply, reason) => {
    const { fetchFn } = playAnswering(reply);
    await expect(lookupPlayApp('com.example.air', fetchFn)).resolves.toStrictEqual({ status: 'unknown', reason });
  });

  it('keeps the app found when the page is over the byte cap', async () => {
    const big = new Response('x', { headers: { 'content-length': String(4_000_000) } });
    const { fetchFn } = playAnswering(big);
    await expect(lookupPlayApp('com.example.air', fetchFn)).resolves.toMatchObject({ status: 'found', app: { name: '' } });
  });
});

describe('playPageDetails', () => {
  it('skips blocks of another type and takes the SoftwareApplication one', () => {
    const html = '<script type="application/ld+json">{"@type":"Organization","name":"Google"}</script>'
      + '<script type="application/ld+json">{"@type":"SoftwareApplication","name":"Example Air"}</script>';
    expect(playPageDetails(html)).toStrictEqual({ name: 'Example Air', developer: '' });
  });

  it('is undefined for a page without one', () => {
    expect(playPageDetails('<html></html>')).toBeUndefined();
  });
});

describe('lookupStoreApp', () => {
  it('asks the App Store for an iOS id and Google Play for an Android package', async () => {
    const hosts: string[] = [];
    const fetchFn: FetchFn = (url) => {
      hosts.push(url.host);
      return Promise.resolve(new Response('', { status: 404 }));
    };
    await lookupStoreApp('android', 'com.example.air', fetchFn);
    expect(hosts).toStrictEqual(['play.google.com']);
    hosts.length = 0;
    await lookupStoreApp('ios', APP_ID, fetchFn);
    expect(new Set(hosts)).toStrictEqual(new Set(['itunes.apple.com']));
  });
});
