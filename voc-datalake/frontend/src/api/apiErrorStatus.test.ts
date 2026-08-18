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

vi.mock('../store/configStore', () => ({
  useConfigStore: {
    getState: vi.fn(() => ({ config: { apiEndpoint: 'https://api.example.com' } })),
  },
}))

vi.mock('../services/auth', () => ({
  authService: {
    isConfigured: vi.fn(() => true),
    getIdToken: vi.fn(() => 'mock-id-token'),
    getAccessToken: vi.fn(() => Promise.resolve('mock-access-token')),
    refreshSession: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn(),
  },
}))

import { apiErrorStatus, isPermanentRefusal } from './apiErrorStatus'
import { fetchApi } from './client'
import { ApiError } from '../lib/errors'
import { resetSessionExpiryForTests } from '../services/sessionExpiry'

/** The rejection a non-OK response actually produces, whatever shape it has. */
async function rejectionFor(status: number): Promise<unknown> {
  ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, status })
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
    global.fetch = vi.fn()
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

  it('recovers every 4xx status, not just the one a caller thought of', async () => {
    // 403 (no permission) and 404 (nothing there) are the two the row-ensure meets in
    // practice; 429 is a refusal by status class and a retry by intent, and it is
    // deliberately read as permanent here — the API's throttling answer is a 5xx.
    for (const status of [403, 404, 409, 429]) {
      // eslint-disable-next-line no-await-in-loop
      expect(isPermanentRefusal(await rejectionFor(status))).toBe(true)
    }
  })

  it('never sees a 401, because fetchApi answers that one itself', async () => {
    // Not an omission from the case above: a 401 is `fetchApi`'s OWN business. It
    // refreshes the session and retries, and only if that fails throws
    // `Session expired. Please login again.` — a message with no status in it — after
    // sending the user to /login. So a caller reading a status can never be handed a
    // 401, and reads that rejection as retryable, which costs nothing: the page it
    // would retry on has been navigated away from.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 })
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
    expect(isPermanentRefusal(new ApiError(403, 'Forbidden: not a reviewer'))).toBe(true)
    expect(isPermanentRefusal(new ApiError(503, 'Upstream unavailable'))).toBe(false)
  })
})
