import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetFeedback = vi.fn()
const mockSearchFeedback = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getFeedback: (params: unknown) => mockGetFeedback(params),
    searchFeedback: (params: unknown) => mockSearchFeedback(params),
  },
}))

import { EMPTY_FEEDBACK_FILTERS } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { useFeedbackListData } from './useFeedbackListData'
import type { CategoryFiltersState } from './useCategoryFilters'

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }

const baseFilters: CategoryFiltersState = {
  searchText: '',
  ratingFilter: { value: 0, direction: 'up' },
  filters: EMPTY_FEEDBACK_FILTERS,
}

/** Base state with some shared (server-side) filter dimensions set. */
function withFilters(patch: Partial<FeedbackFilterState>, searchText = ''): CategoryFiltersState {
  return { ...baseFilters, searchText, filters: { ...EMPTY_FEEDBACK_FILTERS, ...patch } }
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

function renderData(filters: CategoryFiltersState, apiEndpoint = API_ENDPOINT) {
  return renderHook(() => useFeedbackListData(DATE_PARAMS, filters, apiEndpoint), {
    wrapper: createWrapper(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
  mockSearchFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
})

describe('useFeedbackListData', () => {
  describe('default browse-all fetch (issue #198 UX rationalization)', () => {
    it('fetches the list with default filters (nothing selected = show everything)', async () => {
      const { result } = renderData(baseFilters)
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    })

    it('does not fetch without an API endpoint', () => {
      renderData(baseFilters, '')
      expect(mockGetFeedback).not.toHaveBeenCalled()
      expect(mockSearchFeedback).not.toHaveBeenCalled()
    })
  })

  describe('endpoint selection', () => {
    it('uses the search endpoint when the query has 2+ characters', async () => {
      renderData({ ...baseFilters, searchText: 'slow' })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalled())
      expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow' }))
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })

    it('does not search for a single character (falls back to the list)', async () => {
      const { result } = renderData({ ...baseFilters, searchText: 'a' })
      expect(result.current.isSearching).toBe(false)
      expect(mockSearchFeedback).not.toHaveBeenCalled()
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
    })

    it('keeps the paginated list for urgent-only (urgency is a server filter, not an endpoint)', async () => {
      renderData(withFilters({ urgentOnly: true }))
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ urgent: 'true' }))
      )
      expect(mockSearchFeedback).not.toHaveBeenCalled()
    })

    it('applies urgent-only to search results too', async () => {
      renderData(withFilters({ urgentOnly: true }, 'slow'))
      await waitFor(() =>
        expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow', urgent: 'true' }))
      )
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })
  })

  describe('server params', () => {
    it('sends every multi-value dimension comma-joined', async () => {
      renderData(withFilters({
        sources: ['webscraper', 'manual_import'],
        categories: ['delivery', 'pricing'],
        sentiments: ['negative', 'mixed'],
      }))
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({
          source: 'webscraper,manual_import',
          category: 'delivery,pricing',
          sentiment: 'negative,mixed',
        }))
      )
    })

    it('sends enrichment filters under the field name, including unscored', async () => {
      renderData(withFilters({ enrichment: { usefulness: ['high', 'unscored'] } }))
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ usefulness: 'high,unscored' }))
      )
    })

    it('omits empty dimensions entirely', async () => {
      renderData(baseFilters)
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalled())
      const params = mockGetFeedback.mock.calls[0][0]
      for (const key of ['source', 'category', 'subcategory', 'sentiment', 'urgent', 'usefulness']) {
        expect(params).not.toHaveProperty(key)
      }
    })

    it('threads custom filters through as cf_<key> lists (sent as repeated keys)', async () => {
      renderData(withFilters({ customFields: { region: ['EMEA'], tier: ['Gold', 'Platinum'] } }))
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ cf_region: ['EMEA'], cf_tier: ['Gold', 'Platinum'] })
        )
      )
    })

    it('passes the shared filters to the search endpoint too', async () => {
      renderData(withFilters({ customFields: { region: ['EMEA'] }, categories: ['delivery'] }, 'slow'))
      await waitFor(() =>
        expect(mockSearchFeedback).toHaveBeenCalledWith(
          expect.objectContaining({ cf_region: ['EMEA'], category: 'delivery' })
        )
      )
    })
  })

  describe('client-side refinements', () => {
    it('filters out items below the rating threshold with the & up direction', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [makeItem({ feedback_id: 'hi', rating: 5 }), makeItem({ feedback_id: 'lo', rating: 2 })],
      })
      const { result } = renderData({ ...baseFilters, ratingFilter: { value: 4, direction: 'up' } })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
      expect(result.current.filteredFeedback[0].feedback_id).toBe('hi')
    })

    it('filters out items above the rating threshold with the & below direction', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 3,
        items: [
          makeItem({ feedback_id: 'hi', rating: 5 }),
          makeItem({ feedback_id: 'mid', rating: 3 }),
          makeItem({ feedback_id: 'lo', rating: 1 }),
        ],
      })
      const { result } = renderData({ ...baseFilters, ratingFilter: { value: 3, direction: 'below' } })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(2))
      expect(result.current.filteredFeedback.map((i) => i.feedback_id)).toEqual(['mid', 'lo'])
    })

    it('excludes unrated items in both rating directions', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [makeItem({ feedback_id: 'rated', rating: 2 }), makeItem({ feedback_id: 'unrated', rating: undefined })],
      })
      const { result } = renderData({ ...baseFilters, ratingFilter: { value: 3, direction: 'below' } })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
      expect(result.current.filteredFeedback[0].feedback_id).toBe('rated')
    })

    it('trusts the server for categories (no second client-side pass)', async () => {
      // The server already filtered (shared/feedback_filters.py); a second
      // client pass would duplicate that rule and desync rows from the totals.
      mockGetFeedback.mockResolvedValue({
        count: 2,
        items: [
          makeItem({ feedback_id: 'a', category: 'delivery' }),
          makeItem({ feedback_id: 'b', category: 'billing' }),
        ],
      })
      const { result } = renderData(withFilters({ categories: ['delivery', 'pricing'] }))

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(2))
    })
  })

  describe('pagination (list endpoint)', () => {
    it('reports hasMore when the loaded rows are fewer than the windowed total', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        total: 5,
        offset: 0,
        items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })],
      })
      const { result } = renderData(baseFilters)

      await waitFor(() => expect(result.current.hasMore).toBe(true))
      expect(result.current.isLoadingMore).toBe(false)
    })

    it('reports no more pages when the full total is loaded', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 2,
        total: 2,
        offset: 0,
        items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })],
      })
      const { result } = renderData(baseFilters)

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(2))
      expect(result.current.hasMore).toBe(false)
    })

    it('loadMore fetches the next page with the offset and appends the items', async () => {
      mockGetFeedback.mockImplementation((params: { offset?: number }) =>
        Promise.resolve(
          (params.offset ?? 0) === 0
            ? { count: 2, total: 4, offset: 0, items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })] }
            : { count: 2, total: 4, offset: 2, items: [makeItem({ feedback_id: 'c' }), makeItem({ feedback_id: 'd' })] }
        )
      )
      const { result } = renderData(baseFilters)
      await waitFor(() => expect(result.current.hasMore).toBe(true))

      result.current.loadMore()

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(4))
      expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ offset: 2 }))
      expect(result.current.filteredFeedback.map((i) => i.feedback_id)).toEqual(['a', 'b', 'c', 'd'])
      expect(result.current.hasMore).toBe(false)
    })

    it('keeps the previous rows while a new selection loads, without offering to page through them', async () => {
      // First selection: 2 of 5 loaded, so there is a next page.
      mockGetFeedback.mockResolvedValueOnce({
        count: 2, total: 5, offset: 0,
        items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })],
      })
      const { result, rerender } = renderHook(
        ({ state }: { state: CategoryFiltersState }) => useFeedbackListData(DATE_PARAMS, state, API_ENDPOINT),
        { initialProps: { state: baseFilters }, wrapper: createWrapper() },
      )
      await waitFor(() => expect(result.current.hasMore).toBe(true))

      // A new selection whose request never answers.
      mockGetFeedback.mockReturnValue(new Promise(() => {}))
      rerender({ state: withFilters({ sources: ['webscraper'] }) })

      await waitFor(() => expect(result.current.isUpdating).toBe(true))
      expect(result.current.isLoading).toBe(false)
      expect(result.current.filteredFeedback.map((i) => i.feedback_id)).toEqual(['a', 'b'])
      // "Load more" would continue the OLD selection's list.
      expect(result.current.hasMore).toBe(false)
    })

    it('never reports more pages for search results (no server pagination)', async () => {
      mockSearchFeedback.mockResolvedValue({
        count: 2,
        total: 50,
        items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })],
      })
      const { result } = renderData({ ...baseFilters, searchText: 'slow' })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(2))
      expect(result.current.hasMore).toBe(false)
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
      const { result } = renderData(baseFilters)

      await waitFor(() => expect(result.current.totalCount).toBe(250))
      expect(result.current.isPartialWindow).toBe(true)
    })

    it('falls back to count for endpoints without pagination totals', async () => {
      mockSearchFeedback.mockResolvedValue({ count: 7, items: [makeItem()] })
      const { result } = renderData({ ...baseFilters, searchText: 'slow' })

      await waitFor(() => expect(result.current.totalCount).toBe(7))
      expect(result.current.isPartialWindow).toBe(false)
    })
  })
})

describe('the search gate measures what the server measures', () => {
  it('does not search when the term trims below the minimum', async () => {
    // `/feedback/search` trims `q` and now REFUSES a present-but-too-short term
    // with a 400 instead of answering an empty success. Gating on raw `.length`
    // made `"a "` two characters here and one there, so an ordinary typing
    // sequence produced a server error. Nothing should leave the client.
    const { result } = renderData({ ...baseFilters, searchText: 'a ' })

    await waitFor(() => expect(result.current.isSearching).toBe(false))
    expect(mockSearchFeedback).not.toHaveBeenCalled()
  })

  it('sends the trimmed term so the client and the route agree on its length', async () => {
    renderData({ ...baseFilters, searchText: '  delivery  ' })

    await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalled())
    expect(mockSearchFeedback.mock.calls[0][0]).toMatchObject({ q: 'delivery' })
  })

  it('still searches when only the interior has spaces', async () => {
    renderData({ ...baseFilters, searchText: 'slow delivery' })

    await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalled())
    expect(mockSearchFeedback.mock.calls[0][0]).toMatchObject({ q: 'slow delivery' })
  })
})

describe('a truncated search window reaches the display', () => {
  it('reports isPartialWindow from the search response', async () => {
    // The route sets `is_partial_window` when the candidate scan stops on its
    // soft cap. Without this the dashboard would show a bare count for a
    // truncated scan — the same ambiguity the MCP tool was fixed for.
    mockSearchFeedback.mockResolvedValue({
      count: 1, items: [makeItem()], is_partial_window: true,
    })

    const { result } = renderData({ ...baseFilters, searchText: 'delivery' })

    await waitFor(() => expect(result.current.isPartialWindow).toBe(true))
  })

  it('reports a complete search window as complete', async () => {
    mockSearchFeedback.mockResolvedValue({
      count: 1, items: [makeItem()], is_partial_window: false,
    })

    const { result } = renderData({ ...baseFilters, searchText: 'delivery' })

    await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    expect(result.current.isPartialWindow).toBe(false)
  })

  it('treats a route that omits the flag as complete', async () => {
    mockSearchFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })

    const { result } = renderData({ ...baseFilters, searchText: 'delivery' })

    await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    expect(result.current.isPartialWindow).toBe(false)
  })
})
