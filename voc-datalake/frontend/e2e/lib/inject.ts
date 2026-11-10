/**
 * Error-state injection (E2E-COVERAGE-GAPS.md I-5): make one of the app's own
 * API routes fail, in this page only, with `page.route` — a 500, a 403, a
 * timeout, or any status and body. Nothing reaches the deployment for a
 * fulfilled call, so a spec can show an error state on production without
 * breaking anything.
 *
 *   const injected = await injectFailure(page, { method: 'GET', path: /\/memory\/review$/, failure: { status: 500 } })
 *   … load the page, assert its error UI …
 *   expect(injected.hits()).toBeGreaterThan(0)
 *   expect(withoutInjected(problems, injected.spec)).toEqual([])
 *
 * `runStep` judges every API 5xx and every failed request as a problem; the
 * injected ones are expected, so `withoutInjected` drops exactly those.
 */
import type { Page, Request, Route } from '@playwright/test'
import { apiUrl } from './env'

/** A status (default body: a short JSON error, as the API's own) or a network timeout. */
export type Failure =
  | { readonly status: number; readonly body?: unknown }
  | { readonly timeout: true }

export interface InjectionSpec {
  /** HTTP method to fail; any method when absent (CORS preflights are never failed). */
  readonly method?: string
  /** Tested against the URL path (no query), e.g. `/memory$` or `^/v1/projects$`. */
  readonly path: RegExp
  /** Tested against the query string (`?…`, or '' when there is none) when given. */
  readonly query?: RegExp
  readonly failure: Failure
}

export interface Injected {
  readonly spec: InjectionSpec
  /** How many requests were failed so far. */
  hits: () => number
  /** Stop failing (later requests go to the API again). */
  remove: () => Promise<void>
}

/** The JSON error body the app's handlers answer with (`{success:false, message}`). */
export const INJECTED_BODY = { success: false, message: 'Injected by the e2e suite' } as const

export const isTimeout = (failure: Failure): failure is { readonly timeout: true } => 'timeout' in failure

/** Is `url` on the API at `apiBase`, with a path `spec` fails? (What `page.route` is registered for.) */
function onInjectedPath(spec: InjectionSpec, url: URL, apiBase: string): boolean {
  return url.origin === new URL(apiBase).origin && spec.path.test(url.pathname)
}

/** Does a request (method + full URL) hit `spec` on the API at `apiBase`? Pure, for the unit checks. */
export function matchesInjection(spec: InjectionSpec, method: string, url: string, apiBase: string = apiUrl()): boolean {
  if (method === 'OPTIONS') return false
  if (spec.method !== undefined && spec.method.toUpperCase() !== method.toUpperCase()) return false
  const target = new URL(url)
  return onInjectedPath(spec, target, apiBase) && (spec.query === undefined || spec.query.test(target.search))
}

/** CORS headers that let the SPA (another origin) read the fulfilled answer. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers()['origin']
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-headers': 'Authorization, Content-Type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    vary: 'Origin',
  }
}

async function fail(route: Route, failure: Failure): Promise<void> {
  if (isTimeout(failure)) {
    await route.abort('timedout')
    return
  }
  await route.fulfill({
    status: failure.status,
    contentType: 'application/json',
    headers: corsHeaders(route.request()),
    body: JSON.stringify(failure.body ?? INJECTED_BODY),
  })
}

/** Fail every matching request of `page` from now on (until `remove`). */
export async function injectFailure(page: Page, spec: InjectionSpec): Promise<Injected> {
  let hits = 0
  const apiBase = apiUrl()
  const matcher = (url: URL): boolean => onInjectedPath(spec, url, apiBase)
  const handler = async (route: Route): Promise<void> => {
    const request = route.request()
    if (!matchesInjection(spec, request.method(), request.url(), apiBase)) {
      await route.fallback()
      return
    }
    hits += 1
    await fail(route, spec.failure)
  }
  await page.route(matcher, handler)
  return { spec, hits: () => hits, remove: () => page.unroute(matcher, handler) }
}

/** `METHOD /pathname -> status` or `METHOD /pathname failed: …`, as `judge` (lib/fixtures.ts) words a problem (no query). */
const PROBLEM = /^([A-Z]+) (\S+) (?:-> (\d{3})|failed: .*)$/

/**
 * `problems` without the ones the injection caused: a call to an injected route
 * that answered the injected status (or failed, for a timeout). Anything else —
 * another route's 5xx, a page error, the route error boundary — is kept.
 */
export function withoutInjected(problems: readonly string[], ...specs: readonly InjectionSpec[]): string[] {
  return problems.filter((problem) => {
    const match = PROBLEM.exec(problem)
    if (match === null) return true
    const [, method = '', pathname = '', status] = match
    return !specs.some((spec) => {
      if (spec.method !== undefined && spec.method.toUpperCase() !== method) return false
      if (!spec.path.test(pathname)) return false
      return isTimeout(spec.failure) ? status === undefined : status === String(spec.failure.status)
    })
  })
}
