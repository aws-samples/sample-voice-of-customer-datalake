/**
 * Does a store app exist? For `create_app_connector`'s precheck and its approval card (#38): an App Store id
 * or a Google Play package the model proposes is looked up before the card is shown, so an invented one is
 * refused with a reason the model can act on, and the card names the app and its developer.
 *
 * Outbound by design and bounded, like `app-store-search.ts`: two fixed hosts (`itunes.apple.com` Lookup API,
 * `play.google.com` app page), https only, no redirects followed, a timeout, a byte cap while the body streams in.
 * Only the id leaves the Lambda.
 *
 * Answers are three-valued. `missing` means every store read answered and none has the app (a 404 page, an
 * empty lookup); `unknown` means a read failed (timeout, 5xx, a blocked answer), so nothing can be concluded and
 * the caller must not refuse on it.
 */
import { z } from 'zod';
import { ServiceError } from '../lib/errors.js';
import { parseApps, type FetchFn } from './app-store-search.js';
import { cappedText } from './capped-body.js';

/**
 * The storefronts the iOS connector reads (`plugins/app_reviews_ios/ingestor/countries.py` IOS_COUNTRIES,
 * pinned by store-app-lookup.test.ts): an app sold only outside the US is still found.
 */
export const IOS_STOREFRONTS = [
  'us', 'gb', 'de', 'fr', 'jp', 'au', 'ca', 'it', 'es', 'nl',
  'br', 'mx', 'in', 'kr', 'se', 'no', 'dk', 'fi', 'ch', 'at',
  'be', 'pt', 'pl', 'cz', 'ru', 'tr', 'sa', 'ae', 'za', 'sg',
  'hk', 'tw', 'th', 'my', 'ph', 'id', 'vn', 'co', 'cl', 'ar',
] as const;

const LOOKUP_URL = 'https://itunes.apple.com/lookup';
const PLAY_APP_URL = 'https://play.google.com/store/apps/details';
/** One budget for the whole lookup (every storefront / the one Play page). */
const STORE_LOOKUP_TIMEOUT_MS = 6000;
/**
 * Storefront lookups in flight at once after a US miss. This bounds parallelism, not Apple's per-address rate
 * limit: the fan-out is still ~39 requests in a second or two, so a throttled run can end `unknown` (the card
 * then says the store could not be checked). The fan-out runs only for an id the US store does not list.
 */
const MAX_LOOKUPS_IN_FLIGHT = 4;
/**
 * A US miss is `missing` when every other storefront was asked, none has the app and at most this many of
 * them failed (a throttled 429, a 5xx): a few unreadable storefronts do not hide that the app does not exist.
 * More failures than this (or the budget running out) is `unknown`.
 */
export const MAX_FAILED_STOREFRONTS = 4;
const LOOKUP_MAX_BYTES = 256_000;
/** A Play app page is ~1.2 MB and its JSON-LD sits near the end. */
const PLAY_PAGE_MAX_BYTES = 3_000_000;

interface StoreApp {
  name: string;
  developer: string;
}

export type StoreAppLookup =
  | { status: 'found'; app: StoreApp }
  | { status: 'missing' }
  | { status: 'unknown'; reason: string };

type Attempt = { kind: 'found'; app: StoreApp } | { kind: 'missing' } | { kind: 'failed'; reason: string };

function settle(attempts: readonly Attempt[], expected: number, tolerated: number): StoreAppLookup {
  const found = attempts.find((attempt) => attempt.kind === 'found');
  if (found !== undefined) return { status: 'found', app: found.app };
  const failed = attempts.filter((attempt) => attempt.kind === 'failed');
  if (attempts.length === expected && failed.length <= tolerated) return { status: 'missing' };
  const first = failed[0];
  return { status: 'unknown', reason: first?.kind === 'failed' ? first.reason : 'The App Store lookup ran out of time' };
}

function reason(error: unknown, fallback: string): string {
  return error instanceof ServiceError ? error.message : fallback;
}

/** The https URL of one Lookup; the host and path never come from input. */
export function appStoreLookupUrl(appId: string, country: string): URL {
  const url = new URL(LOOKUP_URL);
  url.searchParams.set('id', appId);
  url.searchParams.set('country', country);
  url.searchParams.set('entity', 'software');
  return url;
}

async function lookupInStorefront(appId: string, country: string, signal: AbortSignal, fetchFn: FetchFn): Promise<Attempt> {
  try {
    const response = await fetchFn(appStoreLookupUrl(appId, country), { signal, redirect: 'error' });
    if (!response.ok) return { kind: 'failed', reason: `The App Store answered HTTP ${response.status}` };
    const apps = parseApps(await cappedText(response, LOOKUP_MAX_BYTES, 'The App Store answer is too large'));
    const app = apps.find((candidate) => candidate.id === appId);
    return app === undefined ? { kind: 'missing' } : { kind: 'found', app: { name: app.name, developer: app.developer } };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'failed', reason: 'The App Store answered with something that is not JSON' };
    return { kind: 'failed', reason: reason(error, 'The App Store could not be reached') };
  }
}

/** Ask `countries` with at most MAX_LOOKUPS_IN_FLIGHT at once; stop asking once one has the app or time is up. */
async function lookupInStorefronts(appId: string, countries: readonly string[], signal: AbortSignal, fetchFn: FetchFn): Promise<Attempt[]> {
  const queue = [...countries];
  const attempts: Attempt[] = [];
  const firstHit = new AbortController();
  const shared = AbortSignal.any([firstHit.signal, signal]);
  // A call, not a property read: the flag changes while a lookup is awaited.
  const stopped = (): boolean => shared.aborted;
  const worker = async (): Promise<void> => {
    const country = queue.shift();
    if (country === undefined || stopped()) return;
    const attempt = await lookupInStorefront(appId, country, shared, fetchFn);
    // An attempt cut short by the stop is not an answer (only a hit is kept).
    if (!stopped() || attempt.kind === 'found') attempts.push(attempt);
    if (attempt.kind === 'found') firstHit.abort();
    await worker();
  };
  await Promise.all(Array.from({ length: MAX_LOOKUPS_IN_FLIGHT }, worker));
  return attempts;
}

/** Look `appId` up in the US store, then (only when it has no such app) in the other storefronts. */
export async function lookupAppStoreApp(appId: string, fetchFn: FetchFn = fetch): Promise<StoreAppLookup> {
  const signal = AbortSignal.timeout(STORE_LOOKUP_TIMEOUT_MS);
  const [first, ...others] = IOS_STOREFRONTS;
  const inFirst = await lookupInStorefront(appId, first, signal, fetchFn);
  if (inFirst.kind !== 'missing') return settle([inFirst], 1, 0);
  return settle(await lookupInStorefronts(appId, others, signal, fetchFn), others.length, MAX_FAILED_STOREFRONTS);
}

/** The https URL of a Play app page; the host and path never come from input. */
export function playAppUrl(packageName: string): URL {
  const url = new URL(PLAY_APP_URL);
  url.searchParams.set('id', packageName);
  url.searchParams.set('hl', 'en');
  url.searchParams.set('gl', 'us');
  return url;
}

const playJsonLdSchema = z.object({
  '@type': z.literal('SoftwareApplication'),
  name: z.string().min(1).max(300),
  author: z.object({ name: z.string().max(300) }).optional(),
});

const JSON_LD_BLOCK = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** The app's name and developer from the page's schema.org SoftwareApplication block, when it has one. */
export function playPageDetails(html: string): { name: string; developer: string } | undefined {
  for (const match of html.matchAll(JSON_LD_BLOCK)) {
    try {
      const parsed = playJsonLdSchema.safeParse(JSON.parse(match[1] ?? ''));
      if (parsed.success) return { name: parsed.data.name, developer: parsed.data.author?.name ?? '' };
    } catch {
      // Not JSON: try the next block.
    }
  }
  return undefined;
}

/** The page text, or '' when it is over the cap or breaks off: the app exists either way, only its details are lost. */
async function pageTextOrEmpty(response: Response): Promise<string> {
  try {
    return await cappedText(response, PLAY_PAGE_MAX_BYTES, 'The Google Play page is too large');
  } catch (error) {
    console.warn(`Google Play page not read: ${reason(error, 'the body broke off')}`);
    return '';
  }
}

async function fetchPlayPage(url: URL, fetchFn: FetchFn): Promise<Response | undefined> {
  try {
    return await fetchFn(url, { signal: AbortSignal.timeout(STORE_LOOKUP_TIMEOUT_MS), redirect: 'error' });
  } catch {
    return undefined;
  }
}

/** Is `packageName` on Google Play? 404 = no such app; 200 = found (name and developer when the page has them). */
export async function lookupPlayApp(packageName: string, fetchFn: FetchFn = fetch): Promise<StoreAppLookup> {
  const url = playAppUrl(packageName);
  const response = await fetchPlayPage(url, fetchFn);
  if (response === undefined) return { status: 'unknown', reason: 'Google Play could not be reached' };
  if (response.status === 404) return { status: 'missing' };
  if (!response.ok) return { status: 'unknown', reason: `Google Play answered HTTP ${response.status}` };
  const details = playPageDetails(await pageTextOrEmpty(response));
  return { status: 'found', app: { name: details?.name ?? '', developer: details?.developer ?? '' } };
}

/** The lookup for a connector's store: the App Store id (iOS) or the Google Play package (Android). */
export function lookupStoreApp(platform: 'ios' | 'android', id: string, fetchFn: FetchFn = fetch): Promise<StoreAppLookup> {
  return platform === 'ios' ? lookupAppStoreApp(id, fetchFn) : lookupPlayApp(id, fetchFn);
}
