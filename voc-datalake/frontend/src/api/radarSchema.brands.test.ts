/**
 * The Radar brand list and single-review wire shapes (GET /radar/brands,
 * GET /radar/brands/{brand}/reviews/{id}): one malformed brand costs itself, a missing origin
 * reads as the list, and a review answer without a review is null.
 */
import { describe, expect, it } from 'vitest'
import { normalizeRadarBrands, normalizeRadarReviewDetail } from './radarSchema'

describe('normalizeRadarBrands', () => {
  it('keeps each usable brand with its origin and drops one without a key', () => {
    const brands = normalizeRadarBrands({ brands: [
      { key: 'acme', label: 'Acme', domains: ['acme.example', ''], origin: 'profile', sources: ['rival_reviews'] },
      { label: 'No key' },
      { key: 'globex', label: '' },
    ] })
    expect(brands).toStrictEqual([
      { key: 'acme', label: 'Acme', domains: ['acme.example'], origin: 'profile', sources: ['rival_reviews'] },
      { key: 'globex', label: 'globex', domains: [], origin: 'list', sources: [] },
    ])
  })

  it('reads a malformed answer as no brand', () => {
    expect(normalizeRadarBrands({ brands: 'nope' })).toStrictEqual([])
  })
})

describe('normalizeRadarReviewDetail', () => {
  it('reads the review with its enrichment', () => {
    const detail = normalizeRadarReviewDetail({
      brand: { key: 'acme', label: 'Acme' },
      review: { feedback_id: 'f1', text: 'Slow', sentiment_label: 'negative', category: 'delivery', persona_name: 'Busy parent', language: 'en' },
    })
    expect(detail?.review).toMatchObject({ feedback_id: 'f1', persona_name: 'Busy parent', language: 'en', subcategory: null })
    expect(detail?.brand).toStrictEqual({ key: 'acme', label: 'Acme' })
  })

  it('is null without a review', () => {
    expect(normalizeRadarReviewDetail({ brand: { key: 'acme', label: 'Acme' } })).toBeNull()
  })
})
