/**
 * The review modal's URL helpers: `?review=` (+ `reviewBrand=`) are set on top of the page's own
 * params, and a malformed id or brand never opens anything.
 */
import { describe, expect, it } from 'vitest'
import { reviewFromSearch, reviewSearch } from './useReviewModal'

describe('reviewSearch', () => {
  it('adds the review to the page params', () => {
    expect(reviewSearch('?category=delivery', 'fb_1')).toBe('?category=delivery&review=fb_1')
  })

  it('adds the brand for a Radar review and drops a stale one for ours', () => {
    expect(reviewSearch('', 'r1', 'acme')).toBe('?review=r1&reviewBrand=acme')
    expect(reviewSearch('?review=r1&reviewBrand=acme', 'fb_2')).toBe('?review=fb_2')
  })
})

describe('reviewFromSearch', () => {
  it.each([
    ['?review=fb_1', { reviewId: 'fb_1', reviewBrand: null }],
    ['?review=r1&reviewBrand=acme', { reviewId: 'r1', reviewBrand: 'acme' }],
    ['', { reviewId: null, reviewBrand: null }],
    ['?review=', { reviewId: null, reviewBrand: null }],
    [`?review=${'x'.repeat(129)}`, { reviewId: null, reviewBrand: null }],
    // A brand that is not a brand key opens nothing (never our feedback by mistake).
    ['?review=r1&reviewBrand=Not%20A%20Key', { reviewId: null, reviewBrand: null }],
  ])('%s', (search, expected) => {
    expect(reviewFromSearch(search)).toStrictEqual(expected)
  })
})
