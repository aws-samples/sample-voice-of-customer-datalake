/**
 * @fileoverview The single-form stats and submissions reads are validated at the
 * boundary: a malformed `stats` reads as null and a malformed row costs only itself.
 */
import { describe, expect, it } from 'vitest'
import { normalizeFormStatsMap, parseFormStatsResponse } from './feedbackFormStatsSchema'

const stats = { total_submissions: 12, avg_rating: 4.5, rating_count: 10 }

describe('parseFormStatsResponse', () => {
  it('keeps a well-formed stats object', () => {
    expect(parseFormStatsResponse({ success: true, form_id: 'f1', stats })).toStrictEqual({ stats })
  })

  it('keeps the card headline figure, and reads a malformed one as no figure without losing the counts', () => {
    const headline = { question_id: 'q_nps', type: 'nps', value: 32.5, count: 40, scale_max: 10 }
    expect(parseFormStatsResponse({ stats: { ...stats, headline } }).stats?.headline)
      .toStrictEqual({ type: 'nps', value: 32.5, count: 40, scale_max: 10 })
    expect(parseFormStatsResponse({ stats: { ...stats, headline: { type: 'nps', value: 'high' } } }).stats)
      .toStrictEqual({ ...stats, headline: null })
    expect(parseFormStatsResponse({ stats: { ...stats, headline: null } }).stats?.headline).toBeNull()
  })

  it('reads a malformed or missing stats object as null', () => {
    expect(parseFormStatsResponse({ stats: { total_submissions: 'many' } })).toStrictEqual({ stats: null })
    expect(parseFormStatsResponse(null)).toStrictEqual({ stats: null })
  })
})

describe('normalizeFormStatsMap', () => {
  it('keeps the valid entries of the list\'s stats map and drops a malformed one', () => {
    expect(normalizeFormStatsMap({ form_1: stats, form_2: { total_submissions: -1 } })).toStrictEqual({ form_1: stats })
  })

  it('reads a missing or malformed map as null (the cards then ask for their own stats)', () => {
    expect(normalizeFormStatsMap(undefined)).toBeNull()
    expect(normalizeFormStatsMap(['form_1'])).toBeNull()
  })
})
