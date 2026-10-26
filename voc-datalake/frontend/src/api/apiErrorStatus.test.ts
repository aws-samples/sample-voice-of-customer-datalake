/**
 * @fileoverview The status recovered from a rejection is pinned to what `fetchApi`
 * ACTUALLY throws, not to a message these tests wrote themselves.
 *
 * The point of the file. `apiErrorStatus` reads a status out of an error message
 * because that is all `fetchApi` keeps, and a test that constructs the message it
 * then parses proves only that a regex matches itself: if `fetchApi` ever appends
 * status text or wraps a cause, the private reader silently reports "no status" and
 * `isPermanentRefusal` answers `false` for every 4xx — turning the retry loop it
 * exists to prevent back on, with nothing failing. So the 4xx and 5xx cases below
 * drive a REAL non-OK response through the real `fetchApi` and read the rejection it
 * produces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMock, installFetchMock, mockStatusOnce } from '@test/fetch-mock'

vi.mock('../store/configStore', () => import('@test/api-mocks').then(m => m.configStoreMock('https://api.example.com')))
vi.mock('../services/auth', () => import('@test/api-mocks').then(m => m.authServiceMock()))

import { apiErrorStatus, isPermanentRefusal } from './apiErrorStatus'
import { fetchApi } from './client'
import { ApiError } from '../lib/errors'
import { resetSessionExpiryForTests } from '../services/sessionExpiry'

/** The rejection a non-OK response actually produces, whatever shape it has. */
async function rejectionFor(status: number): Promise<unknown> {
  mockStatusOnce(status)
  try {
    await fetchApi('/anything')
    throw new Error(`fetchApi resolved on ${String(status)}`)
  } catch (error: unknown) {
    return error
  }
}

describe('the status behind a real fetchApi rejection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installFetchMock()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('recovers a 4xx and calls it the server’s settled answer', async () => {
    const reason = await rejectionFor(400)

    expect(apiErrorStatus(reason)).toBe(400)
    expect(isPermanentRefusal(reason)).toBe(true)
  })

  it('recovers a 5xx and calls it worth retrying', async () => {
    // The half that decides a retry HAPPENS. A 500 read as "no status" would still
    // answer `false` here, so this case alone cannot catch a broken reader — which is
    // why its 4xx sibling exists.
    const reason = await rejectionFor(500)

    expect(apiErrorStatus(reason)).toBe(500)
    expect(isPermanentRefusal(reason)).toBe(false)
  })

  // 404 (nothing there) and 409 (a conflict with stored state) answer the same however
  // often they are asked, so the row-ensure must stop asking — as does the 400 its own
  // case above covers. These are the statuses whose permanence is the POINT of the
  // predicate: widening the retryable set until it swallows one of them turns the
  // once-per-mount ask back into a per-refetch loop.
  it.each([404, 409])('recovers the settled %i as a permanent refusal, not just the one a caller thought of', async (status) => {
    expect(isPermanentRefusal(await rejectionFor(status))).toBe(true)
  })

  it('recovers a 429 and calls it worth retrying, because a throttle is not an answer', async () => {
    // INVERTED from asserting `true`. The old justification — "the API's throttling
    // answer is a 5xx" — was simply wrong about the platform: API Gateway answers 429
    // for method and stage throttling, for a usage plan limit, and for the
    // account-level request quota, and the SDKs treat 429 as the retryable status by
    // definition. The caller fans out one request per project inside a single
    // `Promise.allSettled` on mount, which is precisely the burst that trips those
    // limits, so calling a throttle settled is worst exactly when it fires most: the
    // throttled projects are never released, and a page whose whole content is those
    // rows loses them for the rest of the mount with no message on screen.
    const reason = await rejectionFor(429)

    expect(apiErrorStatus(reason)).toBe(429)
    expect(isPermanentRefusal(reason)).toBe(false)
  })

  it('recovers a 403 and calls it worth retrying, because the edge answers it too', async () => {
    // Also inverted. 403 is not only "you may not": AWS WAF answers 403 for a blocked
    // request — including a rate-based rule tripped by the same mount burst as above —
    // and an authorizer answers it for authorization that has LAPSED rather than never
    // existed. A real refusal does live here, so this is the deliberate trade: retrying
    // one costs a further idempotent, refused conditional write per pass, while not
    // retrying a WAF block drops the project off the page silently. The cheap mistake
    // is the one to make.
    const reason = await rejectionFor(403)

    expect(apiErrorStatus(reason)).toBe(403)
    expect(isPermanentRefusal(reason)).toBe(false)
  })

  it('never sees a 401, because fetchApi answers that one itself', async () => {
    // Not an omission from the case above: a 401 is `fetchApi`'s OWN business. It
    // refreshes the session and retries, and only if that fails throws
    // `Session expired. Please login again.` — a message with no status in it — after
    // sending the user to /login. So a caller reading a status can never be handed a
    // 401, and reads that rejection as retryable, which costs nothing: the page it
    // would retry on has been navigated away from.
    fetchMock().mockResolvedValue({ ok: false, status: 401 })
    // The redirect is stubbed the way `client.test.ts` stubs it: `endExpiredSession`
    // calls `location.replace`, which jsdom refuses, and the noise would land in this
    // file's output rather than a failure.
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      value: { href: '', replace: vi.fn() },
      writable: true,
    })
    resetSessionExpiryForTests()

    await expect(fetchApi('/anything')).rejects.toThrow(/Session expired/)

    Object.defineProperty(window, 'location', { value: originalLocation, writable: true })
  })
})

describe('a rejection that never reached a server', () => {
  it('reports no status, and is retryable', () => {
    // A network fault, an abort, a DNS failure: `fetch` rejects before any response
    // exists. Nothing has ANSWERED the request, so the caller must be free to ask
    // again — and hiding a project forever is the worse of the two mistakes.
    expect(apiErrorStatus(new TypeError('Failed to fetch'))).toBeNull()
    expect(isPermanentRefusal(new TypeError('Failed to fetch'))).toBe(false)
  })

  it('reports no status for a non-Error rejection', () => {
    // A thrown string or object carries no message to read at all.
    expect(apiErrorStatus('boom')).toBeNull()
    expect(apiErrorStatus(undefined)).toBeNull()
    expect(isPermanentRefusal({ status: 400 })).toBe(false)
  })

  it('ignores a status-shaped number inside an unrelated message', () => {
    // Anchored, so a message that merely CONTAINS three digits is not mistaken for
    // the format `fetchApi` throws.
    expect(apiErrorStatus(new Error('Session expired. Please login again.'))).toBeNull()
    expect(apiErrorStatus(new Error('failed after 404 attempts'))).toBeNull()
  })
})

describe('a typed status is preferred to a parsed one', () => {
  it('reads ApiError.status directly', () => {
    // `ApiError` carries the status as a field. Preferring it means a caller that
    // migrates `fetchApi` onto `ApiError` — including a custom message — keeps
    // working, which a message-only reader would not.
    expect(apiErrorStatus(new ApiError(403))).toBe(403)
    expect(apiErrorStatus(new ApiError(503, 'Upstream unavailable'))).toBe(503)
    // Custom messages on purpose: none of these three parses as `API Error: {status}`,
    // so each answer can ONLY come from the typed field. The permanence case carries a
    // 404 rather than the 403 it used to, because a 403 now answers `false` — and so
    // does a dropped `ApiError` branch, which would have left that one assertion passing
    // for the wrong reason while the line above it did all the pinning.
    expect({
      notFound: isPermanentRefusal(new ApiError(404, 'No such project')),
      unavailable: isPermanentRefusal(new ApiError(503, 'Upstream unavailable')),
      waf: isPermanentRefusal(new ApiError(403, 'Blocked by WAF')),
    }).toStrictEqual({ notFound: true, unavailable: false, waf: false })
  })
})
