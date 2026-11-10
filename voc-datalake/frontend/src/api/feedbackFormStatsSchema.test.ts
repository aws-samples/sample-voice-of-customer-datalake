/**
 * @fileoverview The single-form stats and submissions reads are validated at the
 * boundary: a malformed `stats` reads as null and a malformed row costs only itself.
 */
import { describe, expect, it } from 'vitest'
import { parseFormStatsResponse, parseFormSubmissionsResponse } from './feedbackFormStatsSchema'

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

describe('parseFormSubmissionsResponse', () => {
  it('keeps valid rows, fills sparse fields and drops rows without an id', () => {
    const parsed = parseFormSubmissionsResponse({
      stats,
      submissions: [
        { feedback_id: 'fb_1', original_text: 'Great', rating: 5, sentiment_label: 'positive', category: 'delivery', created_at: '2026-01-01T10:00:00Z', persona_name: '' },
        { feedback_id: 'fb_2', rating: 'five' },
        { original_text: 'no id' },
      ],
    })
    expect(parsed.stats).toStrictEqual(stats)
    expect(parsed.submissions.map((row) => row.feedback_id)).toStrictEqual(['fb_1', 'fb_2'])
    expect(parsed.submissions[1]).toStrictEqual({
      feedback_id: 'fb_2', original_text: '', rating: null, sentiment_label: '', category: '', created_at: '', persona_name: '',
    })
  })

  it('reads a body that is not an object as no stats and no rows', () => {
    expect(parseFormSubmissionsResponse('oops')).toStrictEqual({ stats: null, submissions: [] })
  })
})
