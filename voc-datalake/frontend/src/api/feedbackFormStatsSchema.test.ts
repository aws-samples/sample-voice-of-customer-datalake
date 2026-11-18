/**
 * @fileoverview The single-form stats and submissions reads are validated at the
 * boundary: a malformed `stats` reads as null and a malformed row costs only itself.
 */
import { describe, expect, it } from 'vitest'
import { parseFormStatsResponse } from './feedbackFormStatsSchema'

const stats = { total_submissions: 12, avg_rating: 4.5, rating_count: 10 }

describe('parseFormStatsResponse', () => {
  it('keeps a well-formed stats object', () => {
    expect(parseFormStatsResponse({ success: true, form_id: 'f1', stats })).toStrictEqual({ stats })
  })

  it('reads a malformed or missing stats object as null', () => {
    expect(parseFormStatsResponse({ stats: { total_submissions: 'many' } })).toStrictEqual({ stats: null })
    expect(parseFormStatsResponse(null)).toStrictEqual({ stats: null })
  })
})
