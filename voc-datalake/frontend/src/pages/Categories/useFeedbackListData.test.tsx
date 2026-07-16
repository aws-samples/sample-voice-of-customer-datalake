import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetFeedback = vi.fn()
const mockSearchFeedback = vi.fn()
const mockGetUrgentFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    searchFeedback: (params: unknown) => mockSearchFeedback(params),
    getUrgentFeedback: (params: unknown) => mockGetUrgentFeedback(params),
  },
}))

import { useFeedbackListData } from './useFeedbackListData'
import type { CategoryFiltersState } from './useCategoryFilters'

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }

const baseFilters: CategoryFiltersState = {
  searchText: '',
  selectedCategories: [],
  selectedKeywords: [],
  selectedSource: null,
  sentimentFilter: 'all',
  minRating: 0,
  showAll: false,
  showUrgentOnly: false,
}

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    original_text: 'Great delivery service',
    sentiment_label: 'positive',
    sentiment_score: 0.9,
    category: 'delivery',
    source_created_at: '2026-01-01T10:00:00Z',
    rating: 5,
    problem_summary: null,
    ...overrides,
  }
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function renderData(filters: CategoryFiltersState) {
  return renderHook(() => useFeedbackListData(DATE_PARAMS, filters, API_ENDPOINT), {
    wrapper: createWrapper(),
  })
}

beforeEach(() => {
  mockGetFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
  mockSearchFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
  mockGetUrgentFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
})

describe('useFeedbackListData', () => {
  describe('fetch gating (shouldFetchFeedback)', () => {
    it('does not fetch with default filters', () => {
      const { result } = renderData(baseFilters)
      expect(result.current.shouldFetchFeedback).toBe(false)
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })

    it('fetches when a category is selected', async () => {
      const { result } = renderData({ ...baseFilters, selectedCategories: ['delivery'] })
      expect(result.current.shouldFetchFeedback).toBe(true)
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
    })

    it('fetches when the All view is active (issue #198)', async () => {
      const { result } = renderData({ ...baseFilters, showAll: true })
      expect(result.current.shouldFetchFeedback).toBe(true)
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
    })
  })

  describe('endpoint selection', () => {
    it('uses the search endpoint when the query has 2+ characters', async () => {
      renderData({ ...baseFilters, searchText: 'slow' })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalled())
      expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow' }))
      expect(mockGetFeedback).not.toHaveBeenCalled()
      expect(mockGetUrgentFeedback).not.toHaveBeenCalled()
    })

    it('does not search for a single character', () => {
      const { result } = renderData({ ...baseFilters, searchText: 'a' })
      expect(result.current.isSearching).toBe(false)
      expect(mockSearchFeedback).not.toHaveBeenCalled()
    })

    it('uses the urgent endpoint when the urgent toggle is on', async () => {
      renderData({ ...baseFilters, showUrgentOnly: true })
      await waitFor(() => expect(mockGetUrgentFeedback).toHaveBeenCalled())
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })

    it('search wins over the urgent toggle', async () => {
      renderData({ ...baseFilters, searchText: 'slow', showUrgentOnly: true })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalled())
      expect(mockGetUrgentFeedback).not.toHaveBeenCalled()
    })
  })

  describe('server params', () => {
    it('passes a single selected category to the server', async () => {
      renderData({ ...baseFilters, selectedCategories: ['delivery'] })
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'delivery' }))
      )
    })

    it('omits the category param for multi-select (refined client-side)', async () => {
      renderData({ ...baseFilters, selectedCategories: ['delivery', 'pricing'] })
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: undefined }))
      )
    })
  })

  describe('client-side refinements', () => {
    it('filters out items below the min rating', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [makeItem({ feedback_id: 'hi', rating: 5 }), makeItem({ feedback_id: 'lo', rating: 2 })],
      })
      const { result } = renderData({ ...baseFilters, showAll: true, minRating: 4 })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
      expect(result.current.filteredFeedback[0].feedback_id).toBe('hi')
    })

    it('applies multi-category filtering client-side', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [
          makeItem({ feedback_id: 'a', category: 'delivery' }),
          makeItem({ feedback_id: 'b', category: 'billing' }),
        ],
      })
      const { result } = renderData({ ...baseFilters, selectedCategories: ['delivery', 'pricing'] })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
      expect(result.current.filteredFeedback[0].feedback_id).toBe('a')
    })

    it('applies keyword matching against text and problem summary', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [
          makeItem({ feedback_id: 'match', original_text: 'The delivery was slow' }),
          makeItem({ feedback_id: 'nomatch', original_text: 'Great product' }),
        ],
      })
      const { result } = renderData({ ...baseFilters, selectedKeywords: ['slow'] })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
      expect(result.current.filteredFeedback[0].feedback_id).toBe('match')
    })
  })

  describe('results header totals', () => {
    it('prefers total over count and surfaces is_partial_window', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 1,
        total: 250,
        is_partial_window: true,
        items: [makeItem()],
      })
      const { result } = renderData({ ...baseFilters, showAll: true })

      await waitFor(() => expect(result.current.totalCount).toBe(250))
      expect(result.current.isPartialWindow).toBe(true)
    })

    it('falls back to count for endpoints without pagination totals', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 7, items: [makeItem()] })
      const { result } = renderData({ ...baseFilters, showUrgentOnly: true })

      await waitFor(() => expect(result.current.totalCount).toBe(7))
      expect(result.current.isPartialWindow).toBe(false)
    })
  })
})
