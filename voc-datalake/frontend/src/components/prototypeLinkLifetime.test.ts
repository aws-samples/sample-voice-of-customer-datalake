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
