/**
 * @fileoverview The HTTP status behind a rejected API call, recovered from what
 * `fetchApi` actually throws.
 *
 * `fetchApi` (in `client.ts`) reports a non-OK response as `new Error('API Error:
 * {status}')` and DISCARDS the response body — so a caller that needs to tell a
 * refusal from a passing failure has only that text to read. Two callers already
 * read it, and a third would have written the same regex again: the prioritization
 * page decides whether to retry a row-ensure by it, and the ballot page's own
 * module documents the same discarding as the reason its public calls bypass
 * `fetchApi` entirely.
 *
 * Its own module beside `fetchApi` rather than inline at a call site, because the
 * format is a contract between the thrower and every reader of it. A private copy
 * of the pattern in a page cannot fail when the thrower changes: it silently
 * reports "no status", and a reader whose whole purpose is telling 4xx from 5xx
 * then treats every refusal as transient. `apiErrorStatus.test.ts` drives a REAL
 * non-OK response through `fetchApi` and asserts the recovered number, so the pair
 * is pinned by behaviour rather than by two matching literals.
 *
 * `ApiError` (`lib/errors.ts`) carries `status` as a field and is preferred when
 * present: a typed status is better evidence than parsed text, and this way a
 * caller migrating to it keeps working.
 *
 * @module api/apiErrorStatus
 */
import { ApiError } from '../lib/errors'

/** The shape `fetchApi` throws for a non-OK response, and nothing else. */
const API_ERROR_MESSAGE = /^API Error: (\d{3})$/

/**
 * The status a rejection reports, or `null` when it reports none.
 *
 * `null` rather than 0 or a guessed 500, because "no status" is a real and common
 * answer: a network failure, an aborted request and a thrown `TypeError` never
 * reached a server, and a caller deciding retry policy has to be able to tell that
 * from a server's settled reply.
 */
export function apiErrorStatus(reason: unknown): number | null {
  if (reason instanceof ApiError) return reason.status
  const message = reason instanceof Error ? reason.message : ''
  const matched = API_ERROR_MESSAGE.exec(message)
  return matched ? Number(matched[1]) : null
}

/**
 * The two 4xx statuses that are NOT the server's settled answer about the request.
 *
 * Both are answered by the edge rather than by the route, so neither says anything
 * about the request's own merits:
 *
 * - **429** is throttling — API Gateway's method/stage limits, a usage plan, or the
 *   account-level request quota. A caller that fans out one request per project on
 *   mount is exactly the shape that gets throttled, and "you asked too fast" is the
 *   definition of "ask again".
 * - **403** is what AWS WAF answers for a blocked request, including a rate-based
 *   rule tripped by that same burst, and what an authorizer answers for
 *   authorization that has lapsed rather than authorization that was never there.
 *   A genuine "you may not" does live here too, so this one is a JUDGEMENT: the two
 *   mistakes cost wildly different amounts. Retrying a real refusal costs one more
 *   idempotent, refused write per pass; NOT retrying a WAF block or a lapsed token
 *   loses that project off the page for the rest of the mount with nothing on screen
 *   saying so. Cheap-and-wrong beats silent-and-wrong.
 *
 * A status is only listed here when asking again can plausibly get a DIFFERENT
 * reply. 400, 404 and 409 are not: a body the route refuses, a resource that is not
 * there, and a conflict with stored state all answer the same however often they are
 * asked.
 */
const RETRYABLE_4XX = new Set([403, 429])

/**
 * Is this rejection the server's settled answer about the request, rather than a
 * passing failure worth retrying?
 *
 * Most of 4xx says the same thing however many times it is asked — a body the route
 * refuses, a resource that is not there — while a 5xx, a throttle, an edge block and
 * a network fault are all reasons to try again. Anything with NO recoverable status
 * counts as retryable, deliberately: a request that never reached a server has not
 * been answered.
 */
export function isPermanentRefusal(reason: unknown): boolean {
  const status = apiErrorStatus(reason)
  return status !== null && status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)
}
