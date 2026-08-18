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
 * Is this rejection the server's settled answer about the request, rather than a
 * passing failure worth retrying?
 *
 * A 4xx says the same thing however many times it is asked — no permission, a body
 * the route refuses, a resource that is not there — while a 5xx, a throttle and a
 * network fault are all reasons to try again. Anything with NO recoverable status
 * counts as retryable, deliberately: a request that never reached a server has not
 * been answered.
 */
export function isPermanentRefusal(reason: unknown): boolean {
  const status = apiErrorStatus(reason)
  return status !== null && status >= 400 && status < 500
}
