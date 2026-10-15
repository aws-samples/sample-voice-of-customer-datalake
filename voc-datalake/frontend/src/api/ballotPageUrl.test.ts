/**
 * The address a room's phones are pointed at.
 *
 * A QR cannot report its own failure: whatever it encodes, it looks like a QR and
 * scans like one. So every case where this cannot build a usable address has to
 * return null and be said in words by the caller — a wrong-but-well-formed URL is
 * discovered by a room full of phones opening nothing.
 */
import { describe, it, expect } from 'vitest'

import { ballotPageUrl, BALLOT_PAGE_PATH_PREFIX } from './ballotPageUrl'

const SESSION_ID = 'vs_0123456789abcdef0123456789abcdef'

describe('the ballot page address', () => {
  it('is built on the origin the facilitator is looking at', () => {
    // The app's own origin, because the ballot page is a route of this SPA. The
    // API endpoint is a different host, on which /vote/x is a 403.
    expect(ballotPageUrl('https://app.example.com', SESSION_ID))
      .toBe(`https://app.example.com${BALLOT_PAGE_PATH_PREFIX}${SESSION_ID}`)
  })

  it('keeps a port, because that is where a dev server lives', () => {
    expect(ballotPageUrl('http://localhost:5173', SESSION_ID))
      .toBe(`http://localhost:5173${BALLOT_PAGE_PATH_PREFIX}${SESSION_ID}`)
  })

  it('drops anything after the origin rather than building a path onto a path', () => {
    expect(ballotPageUrl('https://app.example.com/prioritization?tab=2', SESSION_ID))
      .toBe(`https://app.example.com${BALLOT_PAGE_PATH_PREFIX}${SESSION_ID}`)
  })

  it.each([
    ['an empty origin', ''],
    ['the literal null origin an about:blank page reports', 'null'],
    ['a file:// page, which no phone can reach', 'file:///Users/x/index.html'],
    ['a non-web scheme', 'chrome-extension://abcdef'],
  ])('refuses to build an address from %s', (_case, origin) => {
    expect(ballotPageUrl(origin, SESSION_ID)).toBeNull()
  })

  it('refuses an empty session id, which would address the route with no token', () => {
    expect(ballotPageUrl('https://app.example.com', '')).toBeNull()
  })

  it('encodes the session id, since it lands in a URL a phone opens', () => {
    // Server-minted today, encoded anyway: an id carrying a '?' or a '/' would
    // otherwise address something else entirely.
    expect(ballotPageUrl('https://app.example.com', 'vs_a/b?c'))
      .toBe(`https://app.example.com${BALLOT_PAGE_PATH_PREFIX}vs_a%2Fb%3Fc`)
  })
})
