/**
 * @fileoverview Tests for the persona source-feedback boundary schemas.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizePersonaFeedbackPreview,
  normalizePersonaSourceFeedback,
  optionalProvenanceSchema,
} from './personaFeedbackSchema'

const provenance = { items_used: 145, items_matched: 612, matched_is_lower_bound: false, sample_limit: 145 }

describe('normalizePersonaSourceFeedback', () => {
  it('keeps a well-formed page, normalizing its feedback rows', () => {
    const page = normalizePersonaSourceFeedback({
      available: true,
      scope: 'used',
      total: 30,
      offset: 25,
      items: [{ feedback_id: 'f1', original_text: 'Late again', sentiment_score: '0.4', date: '2025-01-15' }],
      missing: 2,
      provenance,
    })

    expect(page).toMatchObject({ available: true, scope: 'used', total: 30, offset: 25, missing: 2, provenance })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      feedback_id: 'f1', original_text: 'Late again', sentiment_score: 0.4, source_platform: '', date: '2025-01-15',
    })
  })

  it('reads a non-object response as an unavailable, empty page instead of throwing', () => {
    for (const raw of [null, undefined, 'oops', 42, ['a']]) {
      expect(normalizePersonaSourceFeedback(raw)).toStrictEqual({
        available: false, scope: 'cited', total: 0, offset: 0, items: [], missing: 0, provenance: null,
      })
    }
  })

  it('defaults fields that are missing or of the wrong type', () => {
    const page = normalizePersonaSourceFeedback({
      available: 'yes', scope: 'everything', total: -3, offset: 1.5, missing: 'two', items: [],
    })

    expect(page).toStrictEqual({
      available: false, scope: 'cited', total: 0, offset: 0, items: [], missing: 0, provenance: null,
    })
  })

  it('reads a non-array items field as no rows', () => {
    expect(normalizePersonaSourceFeedback({ available: true, total: 3, items: { feedback_id: 'f1' } }).items).toStrictEqual([])
  })

  it('drops item entries that are not objects and keeps the rest', () => {
    const page = normalizePersonaSourceFeedback({
      available: true, total: 3, items: [null, 'f2', { feedback_id: 'f3' }],
    })

    expect(page.items.map((item) => item.feedback_id)).toStrictEqual(['f3'])
  })

  it('omits the row date when the stored one is not a string', () => {
    const [item] = normalizePersonaSourceFeedback({ available: true, total: 1, items: [{ feedback_id: 'f1', date: 20250115 }] }).items

    expect(item).not.toHaveProperty('date')
  })

  it('reads a null or partial provenance as null', () => {
    expect(normalizePersonaSourceFeedback({ available: true, provenance: null }).provenance).toBeNull()
    expect(normalizePersonaSourceFeedback({ available: true, provenance: { items_used: 4 } }).provenance).toBeNull()
  })

  it('defaults the optional provenance flags rather than dropping the counts', () => {
    expect(normalizePersonaSourceFeedback({
      available: true, provenance: { items_used: 4, items_matched: 9, matched_is_lower_bound: 'no' },
    }).provenance).toStrictEqual({ items_used: 4, items_matched: 9, matched_is_lower_bound: false, sample_limit: 0 })
  })
})

describe('optionalProvenanceSchema', () => {
  it('reads absent, null and malformed persona provenance as undefined', () => {
    expect(optionalProvenanceSchema.parse(undefined)).toBeUndefined()
    expect(optionalProvenanceSchema.parse(null)).toBeUndefined()
    expect(optionalProvenanceSchema.parse({ items_used: 'many', items_matched: 3 })).toBeUndefined()
    expect(optionalProvenanceSchema.parse(provenance)).toStrictEqual(provenance)
  })
})

describe('normalizePersonaFeedbackPreview', () => {
  it('keeps a well-formed preview', () => {
    expect(normalizePersonaFeedbackPreview({ matched: 612, matched_is_lower_bound: true, sample_limit: 145, estimated: false }))
      .toStrictEqual({ matched: 612, matched_is_lower_bound: true, sample_limit: 145, estimated: false })
  })

  it('keeps the estimated flag of a sampled preview', () => {
    expect(normalizePersonaFeedbackPreview({ matched: 28000, sample_limit: 145, estimated: true }).estimated).toBe(true)
  })

  it('reads a preview from an older server, which never estimated, as exact', () => {
    expect(normalizePersonaFeedbackPreview({ matched: 612, sample_limit: 145 }).estimated).toBe(false)
  })

  it('keeps a real zero match count', () => {
    expect(normalizePersonaFeedbackPreview({ matched: 0, sample_limit: 145 }).matched).toBe(0)
  })

  it('reads unreadable counts as unknown rather than zero', () => {
    expect(normalizePersonaFeedbackPreview({ matched: '12', matched_is_lower_bound: 1, sample_limit: null, estimated: 'yes' }))
      .toStrictEqual({ matched: null, matched_is_lower_bound: false, sample_limit: null, estimated: false })
  })

  it('reads a non-object response as an unknown preview instead of throwing', () => {
    expect(normalizePersonaFeedbackPreview('nope'))
      .toStrictEqual({ matched: null, matched_is_lower_bound: false, sample_limit: null, estimated: false })
  })
})
