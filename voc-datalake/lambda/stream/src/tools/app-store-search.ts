/**
 * Apple's public iTunes Search API, for `find_app_store_app`.
 *
 * Outbound by design and bounded: ONE fixed host (`itunes.apple.com`, https),
 * no redirects followed (`redirect: 'error'`), only the `software` entity, a
 * timeout, a byte cap enforced while the body streams in (it is never buffered
 * whole), and a zod parse of the answer that keeps only results whose store
 * link is an `https://apps.apple.com/` page. The search term is an app name the user asked about; nothing
 * else of the conversation leaves the Lambda.
 */
import { z } from 'zod';
import { ServiceError } from '../lib/errors.js';

const APP_STORE_SEARCH_URL = 'https://itunes.apple.com/search';
const APP_STORE_TIMEOUT_MS = 5000;
export const APP_STORE_MAX_BYTES = 512_000;
const APP_STORE_RESULT_LIMIT = 8;
/** The only store links a result may carry (shown to the user, never fetched). */
const APP_STORE_LINK_PREFIX = 'https://apps.apple.com/';

const resultSchema = z.object({
  trackId: z.number().int(),
  trackName: z.string(),
  sellerName: z.string().optional(),
  artistName: z.string().optional(),
  trackViewUrl: z.string().max(2000).startsWith(APP_STORE_LINK_PREFIX),
});

const searchSchema = z.object({ results: z.array(z.unknown()) });

export interface AppStoreApp {
  id: string;
  name: string;
  developer: string;
  url: string;
}

/** The https URL of one search; the host and path never come from input. */
export function appStoreSearchUrl(term: string, country: string): URL {
  const url = new URL(APP_STORE_SEARCH_URL);
  url.searchParams.set('entity', 'software');
  url.searchParams.set('term', term);
  url.searchParams.set('country', country);
  url.searchParams.set('limit', String(APP_STORE_RESULT_LIMIT));
  return url;
}

const TOO_LARGE = 'The App Store answer is too large';

/** Read the stream chunk by chunk; cancel it and refuse as soon as it passes `cap` bytes. */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, cap: number, chunks: readonly Uint8Array[] = [], total = 0): Promise<readonly Uint8Array[]> {
  const { done, value } = await reader.read();
  if (done) return chunks;
  const next = total + value.byteLength;
  if (next > cap) {
    // A failed cancel changes nothing: the refusal below is the answer either way.
    await reader.cancel().then(() => true, () => false);
    throw new ServiceError(TOO_LARGE);
  }
  return readCapped(reader, cap, [...chunks, value], next);
}

/** The response body as text, refused past APP_STORE_MAX_BYTES (declared, or counted while it streams). */
async function cappedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > APP_STORE_MAX_BYTES) throw new ServiceError(TOO_LARGE);
  if (response.body === null) return '';
  const chunks = await readCapped(response.body.getReader(), APP_STORE_MAX_BYTES);
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

function parseApps(text: string): AppStoreApp[] {
  const parsed = searchSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ServiceError('The App Store answered in an unexpected shape');
  return parsed.data.results.flatMap((raw) => {
    const app = resultSchema.safeParse(raw);
    if (!app.success) return [];
    const { trackId, trackName, sellerName, artistName, trackViewUrl } = app.data;
    return [{ id: String(trackId), name: trackName, developer: sellerName ?? artistName ?? '', url: trackViewUrl }];
  });
}

export type FetchFn = (url: URL, init: { signal: AbortSignal; redirect: 'error' }) => Promise<Response>;

/** Search the App Store; resolves to at most APP_STORE_RESULT_LIMIT apps. */
export async function searchAppStore(term: string, country: string, fetchFn: FetchFn = fetch): Promise<AppStoreApp[]> {
  const url = appStoreSearchUrl(term, country);
  const response = await fetchFn(url, { signal: AbortSignal.timeout(APP_STORE_TIMEOUT_MS), redirect: 'error' }).catch(() => {
    throw new ServiceError('The App Store could not be reached');
  });
  if (!response.ok) throw new ServiceError(`The App Store answered HTTP ${response.status}`);
  const text = await cappedText(response);
  try {
    return parseApps(text).slice(0, APP_STORE_RESULT_LIMIT);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ServiceError('The App Store answered with something that is not JSON');
    throw error;
  }
}
