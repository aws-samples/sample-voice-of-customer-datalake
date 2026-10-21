/**
 * @fileoverview Tests for useDashboardData: one result shape from two paths.
 * Unfiltered → the exact aggregate endpoints; filtered → one /metrics/overview scan.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetSummary = vi.fn()
const mockGetSentiment = vi.fn()
const mockGetCategories = vi.fn()
const mockGetSources = vi.fn()
const mockGetUrgentFeedback = vi.fn()
const mockGetEntities = vi.fn()
const mockGetMetricsOverview = vi.fn()
const mockGetLatestDate = vi.fn()

vi.mock('../../api/client', () => ({
  ALL_TIME_DAYS: 3650,
  api: {
    getSummary: (...args: unknown[]) => mockGetSummary(...args),
    getSentiment: (...args: unknown[]) => mockGetSentiment(...args),
    getCategories: (...args: unknown[]) => mockGetCategories(...args),
    getSources: (...args: unknown[]) => mockGetSources(...args),
    getUrgentFeedback: (...args: unknown[]) => mockGetUrgentFeedback(...args),
    getEntities: (...args: unknown[]) => mockGetEntities(...args),
  },
}))

vi.mock('../../api/metricsOverviewApi', () => ({
  getMetricsOverview: (...args: unknown[]) => mockGetMetricsOverview(...args),
}))

vi.mock('../../api/metricsLatestDateApi', () => ({
  getLatestDate: (...args: unknown[]) => mockGetLatestDate(...args),
}))

import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { URGENT_PREVIEW_LIMIT, useDashboardData } from './useDashboardData'

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }
const NEGATIVE_WEBSCRAPER: FeedbackFilterState = {
  ...EMPTY_FEEDBACK_FILTERS,
  sources: ['webscraper'],
  sentiments: ['negative'],
}

const SUMMARY = {
  period_days: 7, total_feedback: 12, avg_sentiment: 0.1, urgent_count: 2,
  daily_totals: [], daily_sentiment: [],
}

/** A fresh QueryClient per test, so no cache is shared between cases. */
function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function renderData(filters: FeedbackFilterState, apiEndpoint = API_ENDPOINT) {
  return renderHook(() => useDashboardData(DATE_PARAMS, 'imported', apiEndpoint, filters), {
    wrapper: createWrapper(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetSummary.mockResolvedValue(SUMMARY)
  mockGetSentiment.mockResolvedValue({ period_days: 7, total: 12, breakdown: { positive: 12 }, percentages: { positive: 100 } })
  mockGetCategories.mockResolvedValue({ period_days: 7, categories: { delivery: 12 } })
  mockGetSources.mockResolvedValue({ period_days: 7, sources: { webscraper: 12 } })
  mockGetUrgentFeedback.mockResolvedValue({ count: 0, items: [] })
  mockGetEntities.mockResolvedValue({ entities: { sources: { webscraper: 12 }, categories: { delivery: 12 } } })
  mockGetMetricsOverview.mockResolvedValue({
    summary: { ...SUMMARY, total_feedback: 3 },
    sentiment: { period_days: 7, total: 3, breakdown: { negative: 3 }, percentages: { negative: 100 } },
    categories: { period_days: 7, categories: { delivery: 3 } },
    sources: { period_days: 7, sources: { webscraper: 3 } },
  })
  mockGetLatestDate.mockResolvedValue({ latest_date: null })
})

describe('useDashboardData', () => {
  it('reads the aggregate endpoints, and never the overview scan, with no filters', async () => {
    const { result } = renderData(EMPTY_FEEDBACK_FILTERS)

    await waitFor(() => expect(result.current.categories?.categories).toEqual({ delivery: 12 }))
    expect(result.current.isFiltered).toBe(false)
    expect(result.current.summary?.total_feedback).toBe(12)
    expect(mockGetSentiment).toHaveBeenCalledWith(DATE_PARAMS)
    expect(mockGetSources).toHaveBeenCalledWith(DATE_PARAMS)
    expect(mockGetMetricsOverview).not.toHaveBeenCalled()
  })

  it('answers from one overview scan, and skips every aggregate, while filters are active', async () => {
    const { result } = renderData(NEGATIVE_WEBSCRAPER)

    await waitFor(() => expect(result.current.summary?.total_feedback).toBe(3))
    expect(result.current.isFiltered).toBe(true)
    expect(result.current.sentiment?.breakdown).toEqual({ negative: 3 })
    expect(result.current.fallback).toBeNull()
    expect(mockGetMetricsOverview).toHaveBeenCalledWith(DATE_PARAMS, NEGATIVE_WEBSCRAPER)
    for (const aggregate of [mockGetSummary, mockGetSentiment, mockGetCategories, mockGetSources]) {
      expect(aggregate).not.toHaveBeenCalled()
    }
  })

  it('applies the filters to the urgent preview and caps it', async () => {
    const { result } = renderData(NEGATIVE_WEBSCRAPER)

    await waitFor(() => expect(result.current.urgentItems).toEqual([]))
    expect(mockGetUrgentFeedback).toHaveBeenCalledWith({
      ...DATE_PARAMS,
      limit: URGENT_PREVIEW_LIMIT,
      source: 'webscraper',
      sentiment: 'negative',
    })
  })

  it('offers every source and category in the window as filter options', async () => {
    const { result } = renderData(NEGATIVE_WEBSCRAPER)

    await waitFor(() => expect(result.current.optionCounts.sources).toEqual({ webscraper: 12 }))
    expect(result.current.optionCounts.categories).toEqual({ delivery: 12 })
  })

  it('reports a failed filtered scan as unknown, not as zero matches, and can retry it', async () => {
    mockGetMetricsOverview.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderData(NEGATIVE_WEBSCRAPER)

    await waitFor(() => expect(result.current.loadFailed).toBe(true))
    expect(result.current.summary).toBeUndefined()

    result.current.retry()
    await waitFor(() => expect(result.current.summary?.total_feedback).toBe(3))
    expect(result.current.loadFailed).toBe(false)
  })

  it('never reports a load failure on the unfiltered aggregate path', async () => {
    mockGetSummary.mockRejectedValue(new Error('boom'))
    const { result } = renderData(EMPTY_FEEDBACK_FILTERS)

    await waitFor(() => expect(mockGetSummary).toHaveBeenCalled())
    expect(result.current.loadFailed).toBe(false)
  })

  it('keeps the unfiltered numbers up, flagged as updating, while the first filtered scan runs', async () => {
    mockGetMetricsOverview.mockReturnValue(new Promise(() => {}))
    const { result, rerender } = renderHook(
      ({ filters }: { filters: FeedbackFilterState }) => useDashboardData(DATE_PARAMS, 'imported', API_ENDPOINT, filters),
      { initialProps: { filters: EMPTY_FEEDBACK_FILTERS }, wrapper: createWrapper() },
    )
    await waitFor(() => expect(result.current.summary?.total_feedback).toBe(12))
    expect(result.current.isUpdating).toBe(false)

    rerender({ filters: NEGATIVE_WEBSCRAPER })

    await waitFor(() => expect(mockGetMetricsOverview).toHaveBeenCalled())
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isUpdating).toBe(true)
    expect(result.current.summary?.total_feedback).toBe(12)
    expect(result.current.categories?.categories).toEqual({ delivery: 12 })
  })

  it('reports loading, not stale numbers, for a first filtered scan with nothing cached to show', () => {
    mockGetMetricsOverview.mockReturnValue(new Promise(() => {}))
    const { result } = renderData(NEGATIVE_WEBSCRAPER)

    expect(result.current.isLoading).toBe(true)
    expect(result.current.isUpdating).toBe(false)
    expect(result.current.summary).toBeUndefined()
  })

  it('fetches nothing without an API endpoint', () => {
    renderData(NEGATIVE_WEBSCRAPER, '')
    for (const call of [mockGetSummary, mockGetMetricsOverview, mockGetUrgentFeedback, mockGetEntities]) {
      expect(call).not.toHaveBeenCalled()
    }
  })
})
