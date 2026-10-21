import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}))

import { EMPTY_FEEDBACK_FILTERS } from './feedbackFilters'
import { getMetricsOverview, normalizeMetricsOverview } from './metricsOverviewApi'

const RAW = {
  period_days: 7,
  feedback_count: 40,
  is_partial: true,
  summary: {
    period_days: 7, total_feedback: 40, avg_sentiment: -0.2, urgent_count: 3, is_partial: true,
    daily_totals: [{ date: '2026-07-01', count: 40 }],
    daily_sentiment: [{ date: '2026-07-01', avg_sentiment: -0.2, count: 40 }],
  },
  sentiment: { total: 40, breakdown: { negative: 30, positive: 10 }, percentages: { negative: 75, positive: 25 } },
  categories: { delivery: 25, pricing: 15 },
  sources: { webscraper: 40 },
  personas: { 'Busy Parent': 5 },
  issues: { 'slow delivery': 12 },
  enrichment: { usefulness: { high: 10, unscored: 30 } },
}

describe('normalizeMetricsOverview', () => {
  it('wraps each breakdown in the shape the existing chart endpoints return', () => {
    const overview = normalizeMetricsOverview(RAW)

    expect(overview.feedback_count).toBe(40)
    expect(overview.summary.urgent_count).toBe(3)
    expect(overview.sentiment).toEqual({
      period_days: 7, is_partial: true, total: 40,
      breakdown: { negative: 30, positive: 10 },
      percentages: { negative: 75, positive: 25 },
    })
    expect(overview.categories).toEqual({ period_days: 7, is_partial: true, categories: { delivery: 25, pricing: 15 } })
    expect(overview.sources).toEqual({ period_days: 7, is_partial: true, sources: { webscraper: 40 } })
    expect(overview.issues).toEqual({ 'slow delivery': 12 })
    expect(overview.enrichment).toEqual({ usefulness: { high: 10, unscored: 30 } })
  })

  it('coerces numeric strings and zeroes garbage counts', () => {
    const overview = normalizeMetricsOverview({ ...RAW, feedback_count: '40', categories: { delivery: '25', bad: 'x' } })
    expect(overview.feedback_count).toBe(40)
    expect(overview.categories.categories).toEqual({ delivery: 25, bad: 0 })
  })

  it('degrades a malformed section without losing the rest', () => {
    const overview = normalizeMetricsOverview({ ...RAW, sentiment: 'broken', summary: null })
    expect(overview.sentiment.breakdown).toEqual({})
    expect(overview.summary.total_feedback).toBe(0)
    expect(overview.categories.categories).toEqual({ delivery: 25, pricing: 15 })
  })

  it('never throws on a non-object body', () => {
    for (const raw of [null, undefined, [], 'oops', 7]) {
      const overview = normalizeMetricsOverview(raw)
      expect(overview.feedback_count).toBe(0)
      expect(overview.categories.categories).toEqual({})
      expect(overview.is_partial).toBe(false)
    }
  })
})

describe('getMetricsOverview', () => {
  beforeEach(() => mockFetchApi.mockReset())

  it('GETs /metrics/overview with the window and every filter dimension', async () => {
    mockFetchApi.mockResolvedValue(RAW)

    const overview = await getMetricsOverview(
      { days: 30, date_basis: 'review' },
      {
        ...EMPTY_FEEDBACK_FILTERS,
        sources: ['webscraper', 'manual_import'],
        sentiments: ['negative'],
        urgentOnly: true,
        enrichment: { usefulness: ['high', 'unscored'] },
        customFields: { region: ['EMEA'] },
      },
    )

    const url = new URL(String(mockFetchApi.mock.calls[0][0]), 'https://api.test')
    expect(url.pathname).toBe('/metrics/overview')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      days: '30',
      date_basis: 'review',
      source: 'webscraper,manual_import',
      sentiment: 'negative',
      urgent: 'true',
      usefulness: 'high,unscored',
      cf_region: 'EMEA',
    })
    expect(overview.feedback_count).toBe(40)
  })
})
