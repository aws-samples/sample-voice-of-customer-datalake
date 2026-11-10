import { describe, expect, it } from 'vitest';
import { APP_STORE_MAX_BYTES, appStoreSearchUrl, searchAppStore, type FetchFn } from './app-store-search.js';

/** A body that streams `chunks` × `size` bytes and records how many chunks were pulled and whether it was cancelled. */
function streaming(chunks: number, size: number) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled === chunks) { controller.close(); return; }
      seen.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
    cancel() { seen.cancelled = true; },
  });
  return { seen, fetchFn: (() => Promise.resolve(new Response(body))) satisfies FetchFn };
}

const APPLE = { results: [{ trackId: 1234567890, trackName: 'Example Air', sellerName: 'Example Air Group', trackViewUrl: 'https://apps.apple.com/x' }, { bad: true }] };
const LINKED = (trackViewUrl?: string) => JSON.stringify({ results: [{ trackId: 1, trackName: 'A', ...(trackViewUrl === undefined ? {} : { trackViewUrl }) }] });

function answering(body: string, init: ResponseInit = {}): { fetchFn: FetchFn; urls: URL[]; inits: Parameters<FetchFn>[1][] } {
  const urls: URL[] = [];
  const inits: Parameters<FetchFn>[1][] = [];
  return { urls, inits, fetchFn: (url, options) => { urls.push(url); inits.push(options); return Promise.resolve(new Response(body, init)); } };
}

describe('searchAppStore', () => {
  it('queries only itunes.apple.com for software and keeps well-formed results', async () => {
    const { fetchFn, urls } = answering(JSON.stringify(APPLE));
    const apps = await searchAppStore('Example Air', 'cl', fetchFn);
    expect(apps).toStrictEqual([{ id: '1234567890', name: 'Example Air', developer: 'Example Air Group', url: 'https://apps.apple.com/x' }]);
    expect(`${urls[0]?.origin}${urls[0]?.pathname}`).toBe('https://itunes.apple.com/search');
    expect(urls[0]?.searchParams.get('entity')).toBe('software');
  });

  it('keeps a hostile term inside the query string', () => {
    const url = appStoreSearchUrl('x@evil.example/#', 'us');
    expect(url.host).toBe('itunes.apple.com');
    expect(url.searchParams.get('term')).toBe('x@evil.example/#');
  });

  it('refuses an answer over the size cap', async () => {
    const { fetchFn } = answering('x'.repeat(APP_STORE_MAX_BYTES + 1));
    await expect(searchAppStore('Example Air', 'us', fetchFn)).rejects.toThrow('too large');
  });

  it('stops reading and cancels a body as soon as it passes the cap, without buffering the rest', async () => {
    const size = 64_000;
    const { seen, fetchFn } = streaming(1000, size);
    await expect(searchAppStore('Example Air', 'us', fetchFn)).rejects.toThrow('too large');
    expect(seen.pulled).toBeLessThanOrEqual(Math.ceil(APP_STORE_MAX_BYTES / size) + 2);
    expect(seen.cancelled).toBe(true);
  });

  it('refuses a declared Content-Length over the cap before reading the body', async () => {
    const { fetchFn } = answering('{}', { headers: { 'content-length': String(APP_STORE_MAX_BYTES + 1) } });
    await expect(searchAppStore('Example Air', 'us', fetchFn)).rejects.toThrow('too large');
  });

  it('never follows a redirect', async () => {
    const { fetchFn, inits } = answering(JSON.stringify(APPLE));
    await searchAppStore('Example Air', 'us', fetchFn);
    expect(inits[0]?.redirect).toBe('error');
  });

  it.each([['ftps://apps.apple.com/x'], ['https://itunes.apple.com/x'], ['//apps.apple.com/x'], ['https://apps.apple.com.evil.example/x'], ['https://evil.example/apps.apple.com/'], [undefined]])(
    'drops a result whose store link is %s', async (link) => {
      expect(await searchAppStore('A', 'us', answering(LINKED(link)).fetchFn)).toStrictEqual([]);
    },
  );

  it('refuses an HTTP error, non-JSON and an unreachable store', async () => {
    await expect(searchAppStore('a', 'us', answering('{}', { status: 503 }).fetchFn)).rejects.toThrow('HTTP 503');
    await expect(searchAppStore('a', 'us', answering('<html>').fetchFn)).rejects.toThrow('not JSON');
    await expect(searchAppStore('a', 'us', () => Promise.reject(new Error('dns')))).rejects.toThrow('could not be reached');
  });
});
