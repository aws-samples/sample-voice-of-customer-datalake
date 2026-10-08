/**
 * Network conditions for tests/network.spec.ts: failing one API route, Chromium's slow-3G emulation, and an in-page cut of the assistant's
 * `/chat/stream` answer after its first text bytes.
 */
import type { Page, Route } from '@playwright/test'
import { apiUrl } from './env'

/** `GET {api}{path}` exactly (query string ignored). */
export function apiGetMatcher(path: string): (url: URL) => boolean {
  const api = new URL(apiUrl())
  const full = `${api.pathname.replace(/\/+$/, '')}${path}`
  return (url) => url.origin === api.origin && url.pathname === full
}

/** Fails every GET to `path` as a dropped connection until `restore()` is awaited. */
export async function failApiGet(page: Page, path: string): Promise<{ restore: () => Promise<void> }> {
  const matches = apiGetMatcher(path)
  const handler = (route: Route): Promise<void> =>
    route.request().method() === 'GET' ? route.abort('internetdisconnected') : route.fallback()
  // The same predicate object for route and unroute: Playwright matches routes by identity.
  await page.route(matches, handler)
  return { restore: () => page.unroute(matches, handler) }
}

/** Chrome DevTools' "Slow 3G" preset (latency 2 s round trip, ~50 KB/s). */
export const SLOW_3G = { offline: false, latency: 2000, downloadThroughput: (500 * 1024) / 8, uploadThroughput: (500 * 1024) / 8 }

/** Applies `SLOW_3G` to `page` (Chromium only); returns the function that lifts it. */
export async function emulateSlow3g(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', SLOW_3G)
  return async () => {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await cdp.detach()
  }
}

/**
 * Client-side navigation (react-router listens to popstate): the SPA, its
 * already-loaded chunks and its query cache stay, only the route changes. A
 * full `page.goto` offline would not even load the shell.
 */
export async function navigateInApp(page: Page, pathname: string): Promise<void> {
  await page.evaluate((target: string) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, pathname)
}

/** sessionStorage key marking that this tab's one stream cut has fired. */
const STREAM_CUT_FLAG = 'e2e-stream-cut-done'

/**
 * Arms a one-shot cut of the NEXT `POST …/chat/stream`: the SPA receives the
 * stream up to and including the first chunk that carries answer text
 * (`TEXT_MESSAGE_CONTENT`), then the body ends and the network read is
 * cancelled — the connection dropping mid-answer. `window.__vocStreamCut.cutAt`
 * records when. One shot per tab: the init script runs again on every reload,
 * so a `sessionStorage` flag keeps a reloaded page's streams intact (the
 * recovery check reloads right after the cut).
 */
export async function armStreamCut(page: Page): Promise<void> {
  await page.addInitScript((flag: string) => {
    const state: { armed: boolean; cutAt: number | null } = { armed: window.sessionStorage.getItem(flag) === null, cutAt: null }
    Object.defineProperty(window, '__vocStreamCut', { value: state, configurable: true })
    const original = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await original(input, init)
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!state.armed || !/\/chat\/stream$/.test(new URL(href, window.location.href).pathname) || response.body === null) return response
      state.armed = false
      window.sessionStorage.setItem(flag, '1')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read()
          if (done) {
            controller.close()
            return
          }
          controller.enqueue(value)
          if (decoder.decode(value, { stream: true }).includes('TEXT_MESSAGE_CONTENT')) {
            state.cutAt = Date.now()
            await reader.cancel().catch(() => undefined)
            controller.close()
          }
        },
        cancel: () => reader.cancel(),
      })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  }, STREAM_CUT_FLAG)
}


/** When the armed cut fired (epoch ms), or null when it has not. */
export async function streamCutAt(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const state: unknown = Reflect.get(window, '__vocStreamCut')
    const at = typeof state === 'object' && state !== null ? Reflect.get(state, 'cutAt') : null
    return typeof at === 'number' ? at : null
  })
}
