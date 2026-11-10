/**
 * Browser-side expected refusals: a page action the test MEANS the API to refuse (a stale save in a second tab, a
 * page opened on a project the caller cannot see, an unknown vote link). The matching requests get the
 * `voc-e2e-expect/<status>` User-Agent token (lib/trafficTag.ts) on top of the browser's own User-Agent, so the
 * log sweep counts their 4xx as expected. Node-side calls declare theirs through `apiCall` / `e2eFetch` instead.
 *
 * Narrow on purpose: one method (or any), one path pattern, on the API origin only, and only while `action` runs.
 */
import type { Page, Request, Route } from '@playwright/test'
import { apiUrl } from './env'
import { browserUserAgent, expectedStatusToken, type ExpectedStatuses } from './trafficTag'

export interface RefusalMatch {
  /** The HTTP method (`PUT`); absent = any method on that path. */
  readonly method?: string
  /** Tested against the request URL's pathname (it includes the stage, `/v1/...`). */
  readonly path: RegExp
  /** The API origin; defaults to `apiUrl()`'s (unit tests point it at a local server). */
  readonly origin?: string
}

/** Whether `url` is on the declared origin and path (the `page.route` filter; the method is checked per request). */
function urlCovered(match: RefusalMatch, url: URL): boolean {
  return url.origin === (match.origin ?? new URL(apiUrl()).origin) && match.path.test(url.pathname)
}

/** Whether a request is one the declaration covers (pure, for the unit checks). */
export function refusalMatches(match: RefusalMatch, method: string, url: string): boolean {
  const methodCovered = match.method === undefined || match.method.toUpperCase() === method.toUpperCase()
  return methodCovered && urlCovered(match, new URL(url))
}

/** The User-Agent a covered request is sent with: its own (the tagged browser one), then the expect token. */
export function refusalUserAgent(request: Pick<Request, 'headers'>, statuses: ExpectedStatuses): string {
  const token = expectedStatusToken(statuses)
  const own = request.headers()['user-agent'] ?? browserUserAgent()
  return token === null ? own : `${own} ${token}`
}

/**
 * Runs `action` with the matching requests of `page` declaring `statuses` (4xx only; `expectedStatusToken` throws
 * otherwise), then removes the route. `route.fallback` keeps any other handler of the page (an injected failure, a
 * stream tap) in the chain.
 */
export async function expectRefusal<T>(page: Page, match: RefusalMatch, statuses: ExpectedStatuses, action: () => Promise<T>): Promise<T> {
  // Validate before routing: a bad declaration fails here, not inside a route handler.
  expectedStatusToken(statuses)
  const urlMatches = (url: URL): boolean => urlCovered(match, url)
  const handler = async (route: Route, request: Request): Promise<void> => {
    if (!refusalMatches(match, request.method(), request.url())) {
      await route.fallback()
      return
    }
    await route.fallback({ headers: { ...request.headers(), 'user-agent': refusalUserAgent(request, statuses) } })
  }
  await page.route(urlMatches, handler)
  try {
    return await action()
  } finally {
    await page.unroute(urlMatches, handler)
  }
}
