/**
 * @fileoverview Feedback list data for the Categories page.
 *
 * Chooses the right endpoint for the current filters — server-side search
 * (`/feedback/search`) when a query of 2+ chars is present, urgent-only
 * (`/feedback/urgent`) when the toggle is on, otherwise the regular list
 * (`/feedback`) — and applies the client-side refinements (star rating
 * with direction, multi-category) the server doesn't support.
 *
 * The list endpoint paginates via offset/limit: pages accumulate through
 * `loadMore` (infinite query) until the candidate window's `total` is
 * loaded. Search and urgent endpoints don't paginate server-side, so
 * `hasMore` is always false for them.
 *
 * The list is always fetched: the Categories default view browses all
 * feedback (issue #198 UX rationalization). Keyword filtering was folded
 * into server-side search — Trending Keyword clicks populate the search box.
 *
 * @module pages/Categories/useFeedbackListData
 */

import { useMemo } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams, FeedbackItem } from '../../api/client'
import { matchesRatingFilter } from './types'
import type { CategoryFiltersState } from './useCategoryFilters'

const PAGE_LIMIT = 100
export const SEARCH_MIN_CHARS = 2

interface FeedbackResponse {
  items?: FeedbackItem[]
  count?: number
  total?: number
  offset?: number
  is_partial_window?: boolean
}

export interface FeedbackListData {
  filteredFeedback: FeedbackItem[]
  isLoading: boolean
  isSearching: boolean
  /** Candidate-window size for the results header ("N of TOTAL"). */
  totalCount: number
  /** True when the backend truncated the candidate window ("N+"). */
  isPartialWindow: boolean
  /** True when the list endpoint has more pages to load. */
  hasMore: boolean
  /** Fetches the next page. Only the list endpoint paginates; search/urgent never have more. */
  loadMore: () => void
  isLoadingMore: boolean
}

function buildCommonParams(dateParams: DateRangeParams, filters: CategoryFiltersState) {
  return {
    ...dateParams,
    limit: PAGE_LIMIT,
    source: filters.selectedSource ?? undefined,
    sentiment: filters.sentimentFilter !== 'all' ? filters.sentimentFilter : undefined,
    // The list endpoints accept a single category; multi-select is refined client-side.
    category: filters.selectedCategories.length === 1 ? filters.selectedCategories[0] : undefined,
  }
}

function matchesClientFilters(item: FeedbackItem, filters: CategoryFiltersState): boolean {
  if (!matchesRatingFilter(item.rating, filters.ratingFilter)) return false
  if (filters.selectedCategories.length > 1 && !filters.selectedCategories.includes(item.category)) return false
  return true
}

/** Exactly one of the three queries is enabled for any given filter state. */
function computeEnabledQueries(
  apiEndpoint: string,
  isSearching: boolean,
  showUrgentOnly: boolean
): { search: boolean; urgent: boolean; list: boolean } {
  const anyEnabled = !!apiEndpoint
  return {
    search: anyEnabled && isSearching,
    urgent: anyEnabled && !isSearching && showUrgentOnly,
    list: anyEnabled && !isSearching && !showUrgentOnly,
  }
}

/**
 * `total` (candidate window size) is preferred; `count` (page size) is the
 * fallback for endpoints that don't paginate (search/urgent).
 */
function extractTotals(data: FeedbackResponse | undefined): { totalCount: number; isPartialWindow: boolean } {
  return {
    totalCount: data?.total ?? data?.count ?? 0,
    isPartialWindow: data?.is_partial_window ?? false,
  }
}

export function useFeedbackListData(
  dateParams: DateRangeParams,
  filters: CategoryFiltersState,
  apiEndpoint: string
): FeedbackListData {
  const isSearching = filters.searchText.length >= SEARCH_MIN_CHARS
  const enabled = computeEnabledQueries(apiEndpoint, isSearching, filters.showUrgentOnly)
  const commonParams = buildCommonParams(dateParams, filters)

  const searchQuery = useQuery({
    queryKey: ['categories-feedback-search', filters.searchText, commonParams],
    queryFn: () => api.searchFeedback({ q: filters.searchText, ...commonParams }),
    enabled: enabled.search,
  })

  const urgentQuery = useQuery({
    queryKey: ['categories-feedback-urgent', commonParams],
    queryFn: () => api.getUrgentFeedback(commonParams),
    enabled: enabled.urgent,
  })

  const listQuery = useInfiniteQuery({
    queryKey: ['categories-feedback', commonParams],
    queryFn: ({ pageParam }) => api.getFeedback({ ...commonParams, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: enabled.list,
  })

  const active = pickActiveSource(isSearching, filters.showUrgentOnly, { searchQuery, urgentQuery, listQuery })

  const filteredFeedback = useMemo(() => {
    return active.items.filter((item) => matchesClientFilters(item, filters))
  }, [active.items, filters])

  return {
    filteredFeedback,
    isLoading: active.isLoading,
    isSearching,
    totalCount: active.totalCount,
    isPartialWindow: active.isPartialWindow,
    hasMore: active.hasMore,
    loadMore: active.loadMore,
    isLoadingMore: active.isLoadingMore,
  }
}

/**
 * Offset of the next `/feedback` page, or undefined when the loaded rows
 * cover the (windowed) total. `total` is the filtered candidate-window size,
 * so `loaded < total` is the correct hasMore signal (not `count < limit`).
 */
function nextPageOffset(lastPage: FeedbackResponse): number | undefined {
  const pageSize = lastPage.count ?? lastPage.items?.length ?? 0
  const loaded = (lastPage.offset ?? 0) + pageSize
  const total = lastPage.total ?? loaded
  return pageSize > 0 && loaded < total ? loaded : undefined
}

/** The list source normalized so the hook body treats all three endpoints alike. */
interface ActiveFeedbackSource {
  items: FeedbackItem[]
  isLoading: boolean
  totalCount: number
  isPartialWindow: boolean
  hasMore: boolean
  loadMore: () => void
  isLoadingMore: boolean
}

interface SimpleQuery {
  data: FeedbackResponse | undefined
  isLoading: boolean
}

/** Structural subset of UseInfiniteQueryResult — keeps the generics out of the hook. */
interface InfiniteListQuery {
  data: { pages: FeedbackResponse[] } | undefined
  isLoading: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

/** Search and urgent endpoints don't paginate server-side — never more to load. */
function toSimpleSource(query: SimpleQuery): ActiveFeedbackSource {
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    ...extractTotals(query.data),
    hasMore: false,
    loadMore: () => undefined,
    isLoadingMore: false,
  }
}

function toListSource(query: InfiniteListQuery): ActiveFeedbackSource {
  const pages = query.data?.pages ?? []
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined
  return {
    items: pages.flatMap((page) => page.items ?? []),
    isLoading: query.isLoading,
    ...extractTotals(lastPage),
    hasMore: query.hasNextPage,
    loadMore: () => {
      void query.fetchNextPage()
    },
    isLoadingMore: query.isFetchingNextPage,
  }
}

interface ActiveQueries {
  searchQuery: SimpleQuery
  urgentQuery: SimpleQuery
  listQuery: InfiniteListQuery
}

function pickActiveSource(
  isSearching: boolean,
  showUrgentOnly: boolean,
  queries: ActiveQueries
): ActiveFeedbackSource {
  if (isSearching) return toSimpleSource(queries.searchQuery)
  if (showUrgentOnly) return toSimpleSource(queries.urgentQuery)
  return toListSource(queries.listQuery)
}
