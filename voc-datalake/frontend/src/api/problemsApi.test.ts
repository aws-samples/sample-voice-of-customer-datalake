import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchApi = vi.fn()
vi.mock('./client', () => ({
  fetchApi: (...args: unknown[]) => mockFetchApi(...args),
}))

import { EMPTY_FEEDBACK_FILTERS } from './feedbackFilters'
import { getProblems } from './problemsApi'

describe('getProblems', () => {
  beforeEach(() => mockFetchApi.mockReset())

  it('GETs /feedback/problems with the window params and the shared filters', async () => {
    mockFetchApi.mockResolvedValue({ period_days: 7, feedback_count: 0, is_partial: false, problems: [] })
    await getProblems(
      { days: 7, date_basis: 'review' },
      { ...EMPTY_FEEDBACK_FILTERS, sources: ['webscraper', 'manual_import'], urgentOnly: true, customFields: { tier: ['gold'] } },
    )
    const url = new URL(String(mockFetchApi.mock.calls[0][0]), 'https://api.test')
    expect(url.pathname).toBe('/feedback/problems')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      days: '7',
      date_basis: 'review',
      source: 'webscraper,manual_import',
      urgent: 'true',
      cf_tier: 'gold',
    })
  })

  it('sends only the window params when no filters are given', async () => {
    mockFetchApi.mockResolvedValue({ period_days: 7, feedback_count: 0, is_partial: false, problems: [] })
    await getProblems({ days: 7 })
    expect(mockFetchApi).toHaveBeenCalledWith('/feedback/problems?days=7')
  })

  it('returns the parsed problem leaves', async () => {
    mockFetchApi.mockResolvedValue({
      period_days: 7,
      feedback_count: 3,
      is_partial: false,
      problems: [
        { category: 'delivery', subcategory: 'late', problem: 'order late', keywords: ['order', 'late'], count: 3, urgent_count: 1, avg_sentiment: -0.5, root_cause: null },
      ],
    })
    const res = await getProblems({ days: 7 })
    expect(res.feedback_count).toBe(3)
    expect(res.problems[0].problem).toBe('order late')
    expect(res.problems[0].keywords).toEqual(['order', 'late'])
  })

  it('leniently normalizes a malformed leaf instead of throwing', async () => {
    mockFetchApi.mockResolvedValue({
      problems: [
        // Missing most fields, string count — coerced/defaulted, not rejected.
        { problem: 'something', count: '4' },
      ],
    })
    const res = await getProblems({ days: 7 })
    expect(res.problems[0].count).toBe(4)
    expect(res.problems[0].category).toBe('uncategorized')
    expect(res.problems[0].keywords).toEqual([])
    expect(res.is_partial).toBe(false)
  })

  it('drops leaves with no problem text', async () => {
    mockFetchApi.mockResolvedValue({
      problems: [
        { problem: '', count: 2 },
        { problem: 'real problem', count: 5 },
      ],
    })
    const res = await getProblems({ days: 7 })
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0].problem).toBe('real problem')
  })
})
