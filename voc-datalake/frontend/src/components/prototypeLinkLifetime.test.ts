/**
 * When a prototype link dies, and when the app replaces it.
 *
 * The signature is a session-scoped view credential, so the two failure modes
 * this pins are (a) claiming a deadline that cannot be read, which would put a
 * wrong time on screen, and (b) scheduling a refresh that never fires or fires
 * forever. Both are asserted on the pure functions rather than by driving a
 * component through an hour of timers — fake timers have leaked across files in
 * this suite before (see useProjectData.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  signedUrlExpiresAt, earliestPrototypeExpiry, refreshDelayMs, isExpired,
  unsignedUrlKey, formatExpiry,
  REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS,
} from './prototypeLinkLifetime'
import type { ProjectDocument } from '../api/types'

const NOW = 1_700_000_000_000
const EXPIRES_SECONDS = 1_700_003_600
const signed = (expiresSeconds: number) =>
  `https://d111.cloudfront.net/prototypes/proj_1/doc_1.html?Expires=${expiresSeconds}&Signature=abc&Key-Pair-Id=K123`

type PrototypeLike = Pick<ProjectDocument, 'document_type' | 'prototype_url'>
const prototype = (url?: string): PrototypeLike => ({ document_type: 'prototype', prototype_url: url })

describe('signedUrlExpiresAt', () => {
  it('reads the canned-policy Expires as epoch milliseconds', () => {
    // CloudFront expresses Expires in SECONDS; getting this wrong by 1000x would
    // put the deadline in 1970 or the far future without failing anything else.
    expect(signedUrlExpiresAt(signed(EXPIRES_SECONDS))).toBe(EXPIRES_SECONDS * 1000)
  })

  it('returns null for a URL with no signature, so nothing claims a deadline', () => {
    expect(signedUrlExpiresAt('https://d111.cloudfront.net/prototypes/proj_1/doc_1.html')).toBeNull()
  })

  it('returns null when there is no URL at all (legacy inline prototype)', () => {
    expect(signedUrlExpiresAt(undefined)).toBeNull()
    expect(signedUrlExpiresAt('')).toBeNull()
  })

  it('returns null for an unparseable URL instead of throwing', () => {
    // A throw here would take down the whole document pane over a bad string.
    expect(signedUrlExpiresAt('not-a-url?Expires=123')).toBeNull()
  })

  it('returns null for a non-numeric or empty Expires', () => {
    expect(signedUrlExpiresAt(signed(NaN))).toBeNull()
    expect(signedUrlExpiresAt('https://d1.cloudfront.net/p.html?Expires=')).toBeNull()
    expect(signedUrlExpiresAt('https://d1.cloudfront.net/p.html?Expires=soon')).toBeNull()
  })

  it('returns null for a non-positive Expires rather than a 1970 deadline', () => {
    expect(signedUrlExpiresAt(signed(0))).toBeNull()
    expect(signedUrlExpiresAt(signed(-1))).toBeNull()
  })

  it('reads a past Expires rather than rejecting it, so the UI can say it lapsed', () => {
    expect(signedUrlExpiresAt(signed(1_000_000))).toBe(1_000_000_000)
  })
})

/**
 * This is the load-bearing function for the iframe freeze: it decides what counts as
 * "the same document". Get it wrong in one direction and re-signing reloads the frame
 * (the bug the freeze exists to prevent); wrong in the other and selecting a different
 * prototype shows the previous one.
 */
describe('unsignedUrlKey', () => {
  it('is unchanged by a new signature on the same document', () => {
    const a = 'https://d1.cloudfront.net/prototypes/p/d.html?Expires=1&Signature=aaa&Key-Pair-Id=K1'
    const b = 'https://d1.cloudfront.net/prototypes/p/d.html?Expires=999&Signature=zzz&Key-Pair-Id=K1'
    expect(unsignedUrlKey(a)).toBe(unsignedUrlKey(b))
  })

  it('is unaffected by query parameter order', () => {
    const a = 'https://d1.cloudfront.net/prototypes/p/d.html?Expires=1&Signature=aaa'
    const b = 'https://d1.cloudfront.net/prototypes/p/d.html?Signature=aaa&Expires=1'
    expect(unsignedUrlKey(a)).toBe(unsignedUrlKey(b))
  })

  it('differs for a different document', () => {
    const a = 'https://d1.cloudfront.net/prototypes/p/d1.html?Expires=1'
    const b = 'https://d1.cloudfront.net/prototypes/p/d2.html?Expires=1'
    expect(unsignedUrlKey(a)).not.toBe(unsignedUrlKey(b))
  })

  it('differs for a different host, so a distribution change is a different address', () => {
    const a = 'https://d1.cloudfront.net/prototypes/p/d.html'
    const b = 'https://d2.cloudfront.net/prototypes/p/d.html'
    expect(unsignedUrlKey(a)).not.toBe(unsignedUrlKey(b))
  })

  it('treats a trailing slash as a different path, matching how S3 keys work', () => {
    expect(unsignedUrlKey('https://d1.cloudfront.net/p/d.html'))
      .not.toBe(unsignedUrlKey('https://d1.cloudfront.net/p/d.html/'))
  })

  it('falls back to the raw string when the URL will not parse', () => {
    expect(unsignedUrlKey('not-a-url')).toBe('not-a-url')
  })

  it('is undefined when there is no URL, so a legacy prototype has no address', () => {
    expect(unsignedUrlKey(undefined)).toBeUndefined()
    expect(unsignedUrlKey('')).toBeUndefined()
  })
})

describe('formatExpiry', () => {
  const AT_1405 = new Date(2026, 7, 8, 14, 5).getTime()
  const SAME_DAY_NOON = new Date(2026, 7, 8, 12, 0).getTime()
  const DAY_BEFORE = new Date(2026, 7, 7, 23, 50).getTime()

  it('uses a 24-hour clock for a locale that expects one', () => {
    expect(formatExpiry(AT_1405, SAME_DAY_NOON, 'de-DE')).toBe('14:05')
  })

  it('uses a 12-hour clock for a locale that expects one', () => {
    // Forcing HH:mm on en-US was the original defect: a locale-agnostic format is not
    // the same thing as a locale-appropriate one.
    expect(formatExpiry(AT_1405, SAME_DAY_NOON, 'en-US')).toMatch(/2:05/)
  })

  it('omits the date when the deadline is later the same day', () => {
    expect(formatExpiry(AT_1405, SAME_DAY_NOON, 'en-US')).not.toMatch(/2026|\/|\d{4}/)
  })

  /**
   * A time alone reads as ALREADY PAST when the deadline is just after midnight and it
   * is currently 23:50 — the one case where a bare clock time actively misinforms.
   */
  it('includes the date when the deadline falls on another day', () => {
    const formatted = formatExpiry(AT_1405, DAY_BEFORE, 'en-US')
    expect(formatted).toMatch(/2:05/)
    expect(formatted).toMatch(/8/)
    expect(formatted.length).toBeGreaterThan('2:05 PM'.length)
  })

  /**
   * The locale comes from i18next's detection chain — a querystring, a cookie,
   * navigator.language — none of which this code controls, and `Intl` throws RangeError
   * on a malformed tag. Throwing here would take down the whole document pane.
   */
  it('falls back to the runtime locale instead of throwing on a malformed tag', () => {
    expect(() => formatExpiry(AT_1405, SAME_DAY_NOON, 'not a locale!')).not.toThrow()
    expect(formatExpiry(AT_1405, SAME_DAY_NOON, 'not a locale!')).toMatch(/\d/)
  })
})

describe('earliestPrototypeExpiry', () => {
  it('returns null when the project has no documents', () => {
    expect(earliestPrototypeExpiry([])).toBeNull()
  })

  it('ignores non-prototype documents, which never carry a signed URL', () => {
    const docs: PrototypeLike[] = [
      { document_type: 'prd', prototype_url: undefined },
      { document_type: 'prfaq', prototype_url: undefined },
    ]
    expect(earliestPrototypeExpiry(docs)).toBeNull()
  })

  it('returns null for a legacy prototype that has no URL to expire', () => {
    expect(earliestPrototypeExpiry([prototype(undefined)])).toBeNull()
  })

  /**
   * One refetch re-signs every prototype in the payload, so scheduling off the
   * soonest deadline keeps all of them alive. Scheduling off the latest would let
   * an earlier one lapse while the timer waited.
   */
  it('picks the soonest deadline when several prototypes exist', () => {
    const docs = [prototype(signed(EXPIRES_SECONDS)), prototype(signed(EXPIRES_SECONDS - 600))]
    expect(earliestPrototypeExpiry(docs)).toBe((EXPIRES_SECONDS - 600) * 1000)
  })

  it('skips unreadable deadlines but still reports the readable ones', () => {
    const docs = [prototype('not-a-url'), prototype(signed(EXPIRES_SECONDS))]
    expect(earliestPrototypeExpiry(docs)).toBe(EXPIRES_SECONDS * 1000)
  })
})

describe('refreshDelayMs', () => {
  it('schedules nothing when there is no deadline to beat', () => {
    // A timer firing against no prototype is a refetch loop with extra steps.
    expect(refreshDelayMs(null, NOW)).toBeNull()
  })

  it('lands the refresh ahead of expiry, never after it', () => {
    const expiresAt = NOW + 60 * 60_000
    const delay = refreshDelayMs(expiresAt, NOW)
    expect(delay).not.toBeNull()
    expect(NOW + (delay ?? 0)).toBeLessThan(expiresAt)
  })

  it('leaves the full lead time between the refresh and expiry on a fresh URL', () => {
    const expiresAt = NOW + 60 * 60_000
    expect(refreshDelayMs(expiresAt, NOW)).toBe(60 * 60_000 - REFRESH_LEAD_MS)
  })

  /**
   * The floor is what stops a URL that is already expired on arrival — clock skew,
   * or a misconfigured signer — from spinning refetches as fast as the network
   * allows.
   */
  it('floors the delay for a deadline that has already passed', () => {
    expect(refreshDelayMs(NOW - 60_000, NOW)).toBe(MIN_REFRESH_DELAY_MS)
  })

  it('floors the delay for a deadline nearer than the lead time', () => {
    expect(refreshDelayMs(NOW + 60_000, NOW)).toBe(MIN_REFRESH_DELAY_MS)
  })

  it('never returns a negative delay', () => {
    expect(refreshDelayMs(NOW - 10 * 60 * 60_000, NOW)).toBeGreaterThan(0)
  })
})

describe('isExpired', () => {
  it('is false while the link still has life', () => {
    expect(isExpired(NOW + 1000, NOW)).toBe(false)
  })

  it('is true once the deadline has passed', () => {
    expect(isExpired(NOW - 1000, NOW)).toBe(true)
  })

  it('is true exactly at the deadline, since the signature is no longer accepted', () => {
    expect(isExpired(NOW, NOW)).toBe(true)
  })

  it('is false when there is no deadline, so an unsigned link is not called expired', () => {
    expect(isExpired(null, NOW)).toBe(false)
  })
})
