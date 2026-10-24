import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { categoriesApiMocks, clientApiModule, createQueryWrapper } from './categories-fixtures'

vi.mock('../../api/client', () => clientApiModule())

// The configured categories the "Other" refinement compares against.
const configured = vi.hoisted(() => ({ names: ['delivery', 'pricing', 'billing'] }))
vi.mock('../../hooks/useCategories', () => ({
  useCategoriesConfig: () => ({ data: { categories: configured.names.map((name) => ({ name })) } }),
}))

import { useFeedbackListData } from './useFeedbackListData'
import type { CategoryFiltersState } from './useCategoryFilters'
import { at } from '@test/defined'

const mockGetFeedback = categoriesApiMocks.getFeedback
const mockSearchFeedback = categoriesApiMocks.searchFeedback
const mockGetUrgentFeedback = categoriesApiMocks.getUrgentFeedback

const API_ENDPOINT = 'https://api.example.com'
const DATE_PARAMS = { days: 7 }

const baseFilters: CategoryFiltersState = {
  searchText: '',
  selectedCategories: [],
  subcategory: null,
  selectedSource: null,
  sentimentFilter: 'all',
  ratingFilter: { value: 0, direction: 'up' },
  showUrgentOnly: false,
  channel: null,
  dimensionFilter: {},
  tag: null,
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

/** Renders, waits until a next page exists, and asks for it. */
async function renderAndLoadMore(filters: CategoryFiltersState) {
  const { result } = renderData(filters)
  await waitFor(() => expect(result.current.hasMore).toBe(true))
  result.current.loadMore()
  return result
}

function renderData(filters: CategoryFiltersState, apiEndpoint = API_ENDPOINT) {
  return renderHook(() => useFeedbackListData(DATE_PARAMS, filters, apiEndpoint), {
    wrapper: createQueryWrapper(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
  mockSearchFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
  mockGetUrgentFeedback.mockResolvedValue({ count: 1, items: [makeItem()] })
})

/** The `offset` of a `getFeedback` request (the stub's arguments are untyped), 0 when absent. */
function offsetOf(params: unknown): number {
  if (typeof params !== 'object' || params === null || !('offset' in params)) return 0
  return typeof params.offset === 'number' ? params.offset : 0
}

/** `searchText` is below the search minimum: the list endpoint answers and nothing is searched. */
async function expectListNotSearch(searchText: string) {
  renderData({ ...baseFilters, searchText })
  await waitFor(() => expect(mockGetFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, offset: 0 }))
  expect(mockSearchFeedback).not.toHaveBeenCalled()
}

describe('useFeedbackListData', () => {
  describe('default browse-all fetch (issue #198 UX rationalization)', () => {
    it('fetches the list with default filters (nothing selected = show everything)', async () => {
      const { result } = renderData(baseFilters)
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, offset: 0 }))
      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    })

    it('does not fetch without an API endpoint', () => {
      renderData(baseFilters, '')
      expect(mockGetFeedback).not.toHaveBeenCalled()
      expect(mockSearchFeedback).not.toHaveBeenCalled()
      expect(mockGetUrgentFeedback).not.toHaveBeenCalled()
    })
  })

  describe('endpoint selection', () => {
    it('uses the search endpoint when the query has 2+ characters', async () => {
      renderData({ ...baseFilters, searchText: 'slow' })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, q: 'slow' }))
      expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow' }))
      expect(mockGetFeedback).not.toHaveBeenCalled()
      expect(mockGetUrgentFeedback).not.toHaveBeenCalled()
    })

    it('does not search for a single character (falls back to the list)', async () => {
      await expectListNotSearch('a')
    })

    it('uses the urgent endpoint when the urgent toggle is on', async () => {
      renderData({ ...baseFilters, showUrgentOnly: true })
      await waitFor(() => expect(mockGetUrgentFeedback).toHaveBeenCalledWith({ days: 7, limit: 100 }))
      expect(mockGetFeedback).not.toHaveBeenCalled()
    })

    it('search wins over the urgent toggle', async () => {
      renderData({ ...baseFilters, searchText: 'slow', showUrgentOnly: true })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, q: 'slow' }))
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

    it('passes channel, dims and tag to the server', async () => {
      renderData({ ...baseFilters, channel: 'review', dimensionFilter: { product: 'web_shop' }, tag: 'vip' })
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ channel: 'review', dims: 'product:web_shop', tag: 'vip' }))
      )
    })

    it('omits the category param for multi-select (refined client-side)', async () => {
      renderData({ ...baseFilters, selectedCategories: ['delivery', 'pricing'] })
      await waitFor(() =>
        expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: undefined }))
      )
    })
  })

  describe('the star-rating filter is a server filter (counts and pages stay correct)', () => {
    it.each([
      ['& up sends rating_min', { value: 4, direction: 'up' as const }, { rating_min: 4 }],
      ['& below sends rating_max', { value: 3, direction: 'below' as const }, { rating_max: 3 }],
    ])('%s on the list', async (_name, ratingFilter, sent) => {
      renderData({ ...baseFilters, ratingFilter })
      await waitFor(() => expect(mockGetFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, offset: 0, ...sent }))
    })

    it('sends the bound to search and urgent too', async () => {
      const ratingFilter = { value: 4, direction: 'up' as const }
      renderData({ ...baseFilters, ratingFilter, searchText: 'slow' })
      renderData({ ...baseFilters, ratingFilter, showUrgentOnly: true })
      await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalledWith(expect.objectContaining({ rating_min: 4 })))
      await waitFor(() => expect(mockGetUrgentFeedback).toHaveBeenCalledWith(expect.objectContaining({ rating_min: 4 })))
    })

    it('does not re-filter the server answer by rating', async () => {
      // An item the server returned is shown, whatever the client thinks of its rating.
      mockGetFeedback.mockResolvedValue({ count: 1, total: 1, items: [makeItem({ rating: undefined })] })
      const { result } = renderData({ ...baseFilters, ratingFilter: { value: 4, direction: 'up' } })
      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    })
  })

  describe('client-side refinements', () => {
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
      expect(at(result.current.filteredFeedback, 0).feedback_id).toBe('a')
    })

    // The "Other" row counts every review outside the configured categories; selecting
    // it with another row keeps those reviews, a removed category's included.
    it('keeps uncategorised and removed-category reviews when "Other" is one of several selected rows', async () => {
      mockGetFeedback.mockResolvedValue({
        count: 4,
        items: [
          makeItem({ feedback_id: 'a', category: 'delivery' }),
          makeItem({ feedback_id: 'b', category: 'billing' }),
          makeItem({ feedback_id: 'c', category: 'other' }),
          makeItem({ feedback_id: 'd', category: 'customer_support' }),
        ],
      })
      const { result } = renderData({ ...baseFilters, selectedCategories: ['delivery', 'other'] })

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(3))
      expect(result.current.filteredFeedback.map((item) => item.feedback_id)).toStrictEqual(['a', 'c', 'd'])
    })
  })

  describe('pagination (list endpoint)', () => {
    /** The first page — rows `a` and `b` — of a window holding `total` rows. */
    const firstPageOf = (total: number) => ({
      count: 2,
      total,
      offset: 0,
      items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })],
    })

    it('reports hasMore when the loaded rows are fewer than the windowed total', async () => {
      mockGetFeedback.mockResolvedValue(firstPageOf(5))
      const { result } = renderData(baseFilters)

      await waitFor(() => expect(result.current.hasMore).toBe(true))
      expect(result.current.isLoadingMore).toBe(false)
    })

    it('reports no more pages when the full total is loaded', async () => {
      mockGetFeedback.mockResolvedValue(firstPageOf(2))
      const { result } = renderData(baseFilters)

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(2))
      expect(result.current.hasMore).toBe(false)
    })

    it('loadMore fetches the next page with the offset and appends the items', async () => {
      mockGetFeedback.mockImplementation((params: unknown) =>
        Promise.resolve(
          offsetOf(params) === 0
            ? { count: 2, total: 4, offset: 0, items: [makeItem({ feedback_id: 'a' }), makeItem({ feedback_id: 'b' })] }
            : { count: 2, total: 4, offset: 2, items: [makeItem({ feedback_id: 'c' }), makeItem({ feedback_id: 'd' })] }
        )
      )
      const result = await renderAndLoadMore(baseFilters)

      await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(4))
      expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ offset: 2 }))
      expect({
        ids: result.current.filteredFeedback.map((i) => i.feedback_id),
        hasMore: result.current.hasMore,
      }).toStrictEqual({ ids: ['a', 'b', 'c', 'd'], hasMore: false })
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

    it('falls back to the loaded rows when a cursor route names no total', async () => {
      mockGetUrgentFeedback.mockResolvedValue({ count: 1, total: null, has_more: false, next_token: null, items: [makeItem()] })
      const { result } = renderData({ ...baseFilters, showUrgentOnly: true })

      await waitFor(() => expect(result.current.totalCount).toBe(1))
      expect(result.current.isPartialWindow).toBe(false)
    })
  })
})

describe('the subcategory filter (a tag chip opens it; it used to search the raw id)', () => {
  const page = {
    count: 3, total: 3, items: [
      makeItem({ feedback_id: 'a', category: 'support', subcategory: 'support_quality' }),
      makeItem({ feedback_id: 'b', category: 'support', subcategory: 'wait_time' }),
      makeItem({ feedback_id: 'c', category: 'support', subcategory: 'support_quality' }),
    ],
  }

  it('narrows the list to the subcategory inside its category, without a text search', async () => {
    mockGetFeedback.mockResolvedValue(page)
    const { result } = renderData({ ...baseFilters, selectedCategories: ['support'], subcategory: 'support_quality' })

    await waitFor(() => expect(result.current.filteredFeedback.map((i) => i.feedback_id)).toStrictEqual(['a', 'c']))
    expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'support' }))
    expect(mockSearchFeedback).not.toHaveBeenCalled()
  })

  it('counts what it shows, a lower bound while more pages remain', async () => {
    mockGetFeedback.mockResolvedValue({ ...page, total: 9 })
    const { result } = renderData({ ...baseFilters, subcategory: 'support_quality' })

    await waitFor(() => expect(result.current.totalCount).toBe(2))
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isPartialWindow).toBe(true)
  })
})

describe('the search gate measures what the server measures', () => {
  it('does not search when the term trims below the minimum', async () => {
    // `/feedback/search` trims `q` and now REFUSES a present-but-too-short term
    // with a 400 instead of answering an empty success. Gating on raw `.length`
    // made `"a "` two characters here and one there, so an ordinary typing
    // sequence produced a server error. Nothing should leave the client.
    await expectListNotSearch('a ')
  })

  it('sends the trimmed term so the client and the route agree on its length', async () => {
    renderData({ ...baseFilters, searchText: '  delivery  ' })

    await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, q: 'delivery' }))
    expect(at(mockSearchFeedback.mock.calls, 0)[0]).toMatchObject({ q: 'delivery' })
  })

  it('still searches when only the interior has spaces', async () => {
    renderData({ ...baseFilters, searchText: 'slow delivery' })

    await waitFor(() => expect(mockSearchFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, q: 'slow delivery' }))
    expect(at(mockSearchFeedback.mock.calls, 0)[0]).toMatchObject({ q: 'slow delivery' })
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

  it.each([
    ['reports a complete search window as complete', { is_partial_window: false }],
    ['treats a route that omits the flag as complete', {}],
  ])('%s', async (_name, flag) => {
    mockSearchFeedback.mockResolvedValue({ count: 1, items: [makeItem()], ...flag })

    const { result } = renderData({ ...baseFilters, searchText: 'delivery' })

    await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(1))
    expect(result.current.isPartialWindow).toBe(false)
  })
})

/** The `next_token` of a cursor request (the stub's arguments are untyped), '' when absent. */
function tokenOf(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('next_token' in params)) return ''
  return typeof params.next_token === 'string' ? params.next_token : ''
}

/** Rows `${prefix}0..n-1`. */
function rowsOf(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => makeItem({ feedback_id: `${prefix}${i}` }))
}

describe('cursor pagination (urgent and search)', () => {
  // Production finding: "Urgent only" showed "100 of 100" while 110 were urgent.
  const urgentPages = (params: unknown) =>
    Promise.resolve(
      tokenOf(params) === ''
        ? { count: 100, total: 110, has_more: true, next_token: 'tok-2', items: rowsOf('u', 100) }
        : { count: 10, total: null, has_more: false, next_token: null, items: rowsOf('v', 10) }
    )

  it('names the window total on the first page and loads the rest with next_token', async () => {
    mockGetUrgentFeedback.mockImplementation(urgentPages)
    const result = await renderAndLoadMore({ ...baseFilters, showUrgentOnly: true })

    await waitFor(() => expect(result.current.filteredFeedback).toHaveLength(110))
    expect({ total: result.current.totalCount, hasMore: result.current.hasMore, partial: result.current.isPartialWindow })
      .toStrictEqual({ total: 110, hasMore: false, partial: false })
  })

  it('sends the previous page token, not an offset', async () => {
    mockGetUrgentFeedback.mockImplementation(urgentPages)
    await renderAndLoadMore({ ...baseFilters, showUrgentOnly: true })

    await waitFor(() => expect(mockGetUrgentFeedback).toHaveBeenCalledWith(expect.objectContaining({ next_token: 'tok-2' })))
  })

  it('treats an uncounted window with more pages as a lower bound ("N+")', async () => {
    mockGetUrgentFeedback.mockResolvedValue({ count: 2, total: null, has_more: true, next_token: 't', items: rowsOf('u', 2) })
    const { result } = renderData({ ...baseFilters, showUrgentOnly: true })

    await waitFor(() => expect(result.current.isPartialWindow).toBe(true))
    expect(result.current.totalCount).toBe(2)
  })

  it('search pages the same way', async () => {
    mockSearchFeedback.mockImplementation((params: unknown) =>
      Promise.resolve(
        tokenOf(params) === ''
          ? { count: 2, total: 3, has_more: true, next_token: 's-2', items: rowsOf('a', 2) }
          : { count: 1, total: 3, has_more: false, next_token: null, items: rowsOf('b', 1) }
      )
    )
    const result = await renderAndLoadMore({ ...baseFilters, searchText: 'checkout' })

    await waitFor(() => expect(result.current.filteredFeedback.map((i) => i.feedback_id)).toStrictEqual(['a0', 'a1', 'b0']))
    expect(result.current.totalCount).toBe(3)
  })
})
