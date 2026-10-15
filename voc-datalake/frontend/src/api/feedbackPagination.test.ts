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

/** A page of `size` rows reporting `total` as the window size. */
const page = (size: number, total?: number) => ({ count: size, total })

describe('nextPageOffset', () => {
  it('returns the next offset while rows in the window remain unread', () => {
    const first = page(100, 250)
    expect(nextPageOffset(first, [first])).toBe(100)

    const second = page(100, 250)
    expect(nextPageOffset(second, [first, second])).toBe(200)
  })

  it('returns undefined once the loaded rows cover the total', () => {
    const pages = [page(100, 250), page(100, 250), page(50, 250)]
    expect(nextPageOffset(pages[2], pages)).toBeUndefined()
  })

  it('treats a full page as the last one when it completes the total', () => {
    // The `count < limit` heuristic would wrongly keep going here: the page is
    // full, and it is also the end of the window.
    const only = page(100, 100)
    expect(nextPageOffset(only, [only])).toBeUndefined()
  })

  it('keeps paging after a short page that does not reach the total', () => {
    // The mirror of the case above: short does not mean last.
    const only = page(40, 250)
    expect(nextPageOffset(only, [only])).toBe(40)
  })

  it('returns undefined for an empty page even when the total claims more', () => {
    // Anti-spin guard: a server reporting `total > loaded` while returning no
    // rows must not keep the caller asking forever.
    const pages = [page(100, 500), page(0, 500)]
    expect(nextPageOffset(pages[1], pages)).toBeUndefined()
  })

  it('falls back to the item count when the response omits count', () => {
    const only = { total: 10, items: [{}, {}] }
    expect(nextPageOffset(only, [only])).toBe(2)
  })

  it('treats a missing total as the end of the window', () => {
    // No total means nothing says more exists; stopping beats guessing.
    const only = page(100)
    expect(nextPageOffset(only, [only])).toBeUndefined()
  })

  it('advances on rows actually held, not on an offset echoed by the server', () => {
    // Regression guard: deriving `loaded` from a response's echoed `offset`
    // means a response that omits it pins the cursor to one page length and
    // hands back the same offset forever — an endless walk over duplicate rows.
    const pages = [page(100, 500), page(100, 500), page(100, 500)]
    expect(nextPageOffset(pages[0], pages.slice(0, 1))).toBe(100)
    expect(nextPageOffset(pages[1], pages.slice(0, 2))).toBe(200)
    expect(nextPageOffset(pages[2], pages)).toBe(300)
  })

  it('ignores a wrong offset echo entirely', () => {
    // Even a server echoing a nonsense offset cannot misdirect the cursor.
    const first = { count: 100, total: 250, offset: 9999 }
    expect(nextPageOffset(first, [first])).toBe(100)
  })
})
