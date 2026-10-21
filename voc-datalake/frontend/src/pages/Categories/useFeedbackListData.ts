/**
 * @fileoverview Feedback list data for the Categories page.
 *
 * Server-side search (`/feedback/search`) when a query of 2+ chars is present,
 * otherwise the paginated list (`/feedback`). Every shared filter dimension —
 * multi-value source/category/sentiment, urgent-only, enrichment fields, custom
 * fields — is applied by the server (shared/feedback_filters.py), so totals and
 * pagination describe the filtered set. Only the star-rating filter (with its
 * up/below direction) is refined client-side.
 *
 * The list endpoint paginates via offset/limit: pages accumulate through
 * `loadMore` (infinite query) until the candidate window's `total` is loaded.
 * Search doesn't paginate server-side, so `hasMore` is always false for it.
 *
 * @module pages/Categories/useFeedbackListData
 */
import { useMemo } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams, FeedbackItem } from '../../api/client'
import { toFeedbackQueryParams } from '../../api/feedbackFilters'
import { FEEDBACK_PAGE_LIMIT, nextPageOffset } from '../../api/feedbackPagination'
import type { FeedbackPage } from '../../api/feedbackPagination'
import { matchesRatingFilter } from './types'
import type { CategoryFiltersState } from './useCategoryFilters'

export const SEARCH_MIN_CHARS = 2

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
  /** Fetches the next page. Only the list endpoint paginates; search never has more. */
  loadMore: () => void
  isLoadingMore: boolean
  /** The rows belong to an earlier selection while the current one loads. */
  isUpdating: boolean
}

function buildCommonParams(dateParams: DateRangeParams, state: CategoryFiltersState) {
  return {
    ...dateParams,
    limit: FEEDBACK_PAGE_LIMIT,
    ...toFeedbackQueryParams(state.filters),
  }
}

/**
 * `total` (candidate window size) is preferred; `count` (page size) is the
 * fallback for search, which does not paginate.
 */
function extractTotals(data: FeedbackPage | undefined): { totalCount: number; isPartialWindow: boolean } {
  return {
    totalCount: data?.total ?? data?.count ?? 0,
    isPartialWindow: data?.is_partial_window ?? false,
  }
}

export function useFeedbackListData(
  dateParams: DateRangeParams,
  state: CategoryFiltersState,
  apiEndpoint: string
): FeedbackListData {
  // TRIMMED, and measured on the same string the server measures.
  //
  // `/feedback/search` trims `q` before applying its own minimum and REFUSES a
  // present-but-too-short term instead of answering an empty success. Gating on
  // raw `.length` would send `"a "` — two characters here, one there — and the
  // user would see an error from an ordinary typing sequence. Sending the trimmed
  // value too keeps the cache key, the request and the server's view identical.
  const searchText = state.searchText.trim()
  const isSearching = searchText.length >= SEARCH_MIN_CHARS
  const enabled = !!apiEndpoint
  const commonParams = buildCommonParams(dateParams, state)

  // Both keep the previous selection's rows on screen while a new one loads, so
  // a filter change updates the list in place instead of flashing a spinner.
  const searchQuery = useQuery({
    queryKey: ['categories-feedback-search', searchText, commonParams],
    queryFn: () => api.searchFeedback({ q: searchText, ...commonParams }),
    enabled: enabled && isSearching,
    placeholderData: keepPreviousData,
  })

  const listQuery = useInfiniteQuery({
    queryKey: ['categories-feedback', commonParams],
    queryFn: ({ pageParam }) => api.getFeedback({ ...commonParams, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: enabled && !isSearching,
    placeholderData: keepPreviousData,
  })

  const active = isSearching ? toSimpleSource(searchQuery) : toListSource(listQuery)
  const { ratingFilter } = state

  const filteredFeedback = useMemo(
    () => active.items.filter((item) => matchesRatingFilter(item.rating, ratingFilter)),
    [active.items, ratingFilter],
  )

  return {
    filteredFeedback,
    isLoading: active.isLoading,
    isSearching,
    totalCount: active.totalCount,
    isPartialWindow: active.isPartialWindow,
    hasMore: active.hasMore,
    loadMore: active.loadMore,
    isLoadingMore: active.isLoadingMore,
    isUpdating: active.isUpdating,
  }
}

/** The list source normalized so the hook body treats both endpoints alike. */
interface ActiveFeedbackSource {
  items: FeedbackItem[]
  isLoading: boolean
  totalCount: number
  isPartialWindow: boolean
  hasMore: boolean
  loadMore: () => void
  isLoadingMore: boolean
  isUpdating: boolean
}

interface SimpleQuery {
  data: FeedbackPage | undefined
  isLoading: boolean
  isPlaceholderData: boolean
}

/** Structural subset of UseInfiniteQueryResult — keeps the generics out of the hook. */
interface InfiniteListQuery {
  data: { pages: FeedbackPage[] } | undefined
  isLoading: boolean
  isPlaceholderData: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

/** Search doesn't paginate server-side — never more to load. */
function toSimpleSource(query: SimpleQuery): ActiveFeedbackSource {
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    ...extractTotals(query.data),
    hasMore: false,
    loadMore: () => undefined,
    isLoadingMore: false,
    isUpdating: query.isPlaceholderData,
  }
}

function toListSource(query: InfiniteListQuery): ActiveFeedbackSource {
  const pages = query.data?.pages ?? []
  const lastPage = pages.length > 0 ? pages[pages.length - 1] : undefined
  return {
    items: pages.flatMap((page) => page.items ?? []),
    isLoading: query.isLoading,
    ...extractTotals(lastPage),
    // Placeholder pages belong to the previous selection: "Load more" would
    // continue THAT list, so it waits for the current one.
    hasMore: query.hasNextPage && !query.isPlaceholderData,
    isUpdating: query.isPlaceholderData,
    loadMore: () => {
      void query.fetchNextPage()
    },
    isLoadingMore: query.isFetchingNextPage,
  }
}
