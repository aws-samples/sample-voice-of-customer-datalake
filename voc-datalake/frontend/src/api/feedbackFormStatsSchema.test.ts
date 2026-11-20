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

  it('keeps the latest response time and each channel\'s, reading a malformed one as absent', () => {
    const at = '2026-11-19T08:00:00Z'
    expect(parseFormStatsResponse({ stats: { ...stats, last_response_at: at, channels: { link: at, script: 7 } } }).stats)
      .toStrictEqual({ ...stats, last_response_at: at, channels: { link: at, script: undefined } })
    expect(parseFormStatsResponse({ stats: { ...stats, last_response_at: 12, channels: 'all' } }).stats)
      .toStrictEqual({ ...stats, last_response_at: undefined, channels: undefined })
  })
})

describe('normalizeFormStatsMap', () => {
  it('keeps each card\'s well-formed stats, drops a malformed entry (that card asks for its own), and no map is null', () => {
    expect(normalizeFormStatsMap({ f1: stats, f2: { total_submissions: -1 } })).toStrictEqual({ f1: stats })
    expect(normalizeFormStatsMap({})).toStrictEqual({})
    expect([normalizeFormStatsMap(null), normalizeFormStatsMap(['f1']), normalizeFormStatsMap('stats')])
      .toStrictEqual([null, null, null])
  })
})
