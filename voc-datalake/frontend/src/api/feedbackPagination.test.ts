/**
 * @fileoverview Tests for shared /feedback offset pagination (U5b).
 */
import { FEEDBACK_PAGE_LIMIT, nextPageOffset } from './feedbackPagination'

describe('FEEDBACK_PAGE_LIMIT', () => {
  // Pins the client page size to the server's `max_val`. /feedback clamps a
  // larger `limit` silently, so a bump here without a matching bump in
  // `validate_limit` would reintroduce U5b: rows requested, never delivered,
  // nothing reported.
  it('equals the /feedback endpoint maximum of 100', () => {
    expect(FEEDBACK_PAGE_LIMIT).toBe(100)
  })
})

describe('nextPageOffset', () => {
  it('returns the next offset while rows in the window remain unread', () => {
    expect(nextPageOffset({ count: 100, offset: 0, total: 250 })).toBe(100)
    expect(nextPageOffset({ count: 100, offset: 100, total: 250 })).toBe(200)
  })

  it('returns undefined once the loaded rows cover the total', () => {
    expect(nextPageOffset({ count: 50, offset: 200, total: 250 })).toBeUndefined()
  })

  it('treats a full page as the last one when it completes the total', () => {
    // The `count < limit` heuristic would wrongly keep going here: the page is
    // full, and it is also the end of the window.
    expect(nextPageOffset({ count: 100, offset: 0, total: 100 })).toBeUndefined()
  })

  it('keeps paging after a short page that does not reach the total', () => {
    // The mirror of the case above: short does not mean last.
    expect(nextPageOffset({ count: 40, offset: 0, total: 250 })).toBe(40)
  })

  it('returns undefined for an empty page even when the total claims more', () => {
    // Anti-spin guard: a server reporting `total > loaded` while returning no
    // rows must not keep the caller asking forever.
    expect(nextPageOffset({ count: 0, offset: 100, total: 500 })).toBeUndefined()
  })

  it('falls back to the item count when the response omits count', () => {
    expect(nextPageOffset({ offset: 0, total: 10, items: [{}, {}] })).toBe(2)
  })

  it('treats a missing total as the end of the window', () => {
    // No total means nothing says more exists; stopping beats guessing.
    expect(nextPageOffset({ count: 100, offset: 0 })).toBeUndefined()
  })
})
