/**
 * @fileoverview Feedback list data for the Categories page.
 *
 * Chooses the right endpoint for the current filters — server-side search
 * (`/feedback/search`) when a query of 2+ chars is present, urgent-only
 * (`/feedback/urgent`) when the toggle is on, otherwise the regular list
 * (`/feedback`). The star-rating filter is a SERVER filter (`rating_min` /
 * `rating_max`) on all three, so pagination and totals count only matching
 * items; only multi-category selection and the subcategory are still refined
 * client-side (the routes take one category and no subcategory). While a
 * client-side refinement is active the server's total counts the UNREFINED
 * window, so the header counts what is loaded instead (a lower bound while
 * more pages remain).
 *
 * Every endpoint paginates through `loadMore` (infinite query): the list by
 * offset until the candidate window's `total` is loaded, search and urgent by
 * their opaque `next_token` while `has_more`.
 *
 * The list is always fetched: the Categories default view browses all
 * feedback (issue #198 UX rationalization). Keyword filtering was folded
 * into server-side search — Trending Keyword clicks populate the search box.
 *
 * @module pages/Categories/useFeedbackListData
 */

import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { FEEDBACK_PAGE_LIMIT, nextPageOffset, nextPageToken } from '../../api/feedbackPagination'
import type { CursorPage, FeedbackPage } from '../../api/feedbackPagination'
import { attributeFiltersOf, ratingParamsOf } from './useCategoryFilters'
import type { CategoryFiltersState } from './useCategoryFilters'
import { failedReads, type FailedReads, type RetryableRead } from '../../utils/failedReads'
import { categoryBucket } from '../../utils/displayLabels'
import { useCategoriesConfig } from '../../hooks/useCategories'
import { FEEDBACK_SEARCH_MIN_CHARS } from '../../api/feedbackSearch'

export interface FeedbackListData {
  filteredFeedback: FeedbackItem[]
  isLoading: boolean
  /** Window size for the results header ("N of TOTAL"). */
  totalCount: number
  /** True when `totalCount` is a lower bound ("N+"). */
  isPartialWindow: boolean
  /** True when the active endpoint has more pages to load. */
  hasMore: boolean
  /**
   * Reviews loaded so far BEFORE the client-side refinement (subcategory, several categories);
   * null when nothing is refined in the browser, so "N of M loaded match" is only said when true.
   */
  loadedCount: number | null
  /** Fetches the next page of the active endpoint. */
  loadMore: () => void
  isLoadingMore: boolean
  /** The active read failed with nothing to show: not the same as "no feedback found". */
  failure: FailedReads
}

function buildCommonParams(dateParams: DateRangeParams, filters: CategoryFiltersState) {
  return {
    ...dateParams,
    limit: FEEDBACK_PAGE_LIMIT,
    source: filters.selectedSource ?? undefined,
    sentiment: filters.sentimentFilter !== 'all' ? filters.sentimentFilter : undefined,
    // The list endpoints accept a single category; multi-select is refined client-side.
    category: filters.selectedCategories.length === 1 ? filters.selectedCategories[0] : undefined,
    // channel / dims / tag / rating are server-side filters on every list route.
    ...attributeFiltersOf(filters),
    ...ratingParamsOf(filters.ratingFilter),
  }
}

/**
 * The browser-side refinement. A review under no configured category matches
 * the "Other" row (`other`), the same rule the server applies to `category=other`.
 */
function matchesClientFilters(item: FeedbackItem, filters: CategoryFiltersState, configured: readonly string[]): boolean {
  const selected = filters.selectedCategories
  const categoryOk = selected.length <= 1 || selected.includes(item.category)
    || selected.includes(categoryBucket(item.category, configured))
  return categoryOk && (filters.subcategory === null || item.subcategory === filters.subcategory)
}

/** True when the list is narrowed in the browser, so the server's total does not describe it. */
function refinesClientSide(filters: CategoryFiltersState): boolean {
  return filters.selectedCategories.length > 1 || filters.subcategory !== null
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

/** `''` is the first page: the cursor routes take no `next_token` then. */
const FIRST_CURSOR = ''

export function useFeedbackListData(
  dateParams: DateRangeParams,
  filters: CategoryFiltersState,
  apiEndpoint: string
): FeedbackListData {
  // TRIMMED, and measured on the same string the server measures.
  //
  // `/feedback/search` trims `q` before applying its own minimum and now REFUSES
  // a present-but-too-short term instead of answering an empty success. Gating on
  // raw `.length` would send `"a "` — two characters here, one there — and the
  // user would see an error from an ordinary typing sequence. Sending the trimmed
  // value too keeps the cache key, the request and the server's view identical.
  const searchText = filters.searchText.trim()
  const isSearching = searchText.length >= FEEDBACK_SEARCH_MIN_CHARS
  const enabled = computeEnabledQueries(apiEndpoint, isSearching, filters.showUrgentOnly)
  const commonParams = buildCommonParams(dateParams, filters)

  const searchQuery = useInfiniteQuery({
    queryKey: ['categories-feedback-search', searchText, commonParams],
    queryFn: ({ pageParam }) => api.searchFeedback({ q: searchText, ...commonParams, ...cursorParam(pageParam) }),
    initialPageParam: FIRST_CURSOR,
    getNextPageParam: nextPageToken,
    enabled: enabled.search,
  })

  const urgentQuery = useInfiniteQuery({
    queryKey: ['categories-feedback-urgent', commonParams],
    queryFn: ({ pageParam }) => api.getUrgentFeedback({ ...commonParams, ...cursorParam(pageParam) }),
    initialPageParam: FIRST_CURSOR,
    getNextPageParam: nextPageToken,
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

  const { data: categoriesConfig } = useCategoriesConfig()
  const configured = useMemo(() => (categoriesConfig?.categories ?? []).map((c) => c.name), [categoriesConfig])
  const filteredFeedback = useMemo(() => {
    return active.items.filter((item) => matchesClientFilters(item, filters, configured))
  }, [active.items, filters, configured])

  const refined = refinesClientSide(filters)
  return {
    filteredFeedback,
    isLoading: active.isLoading,
    totalCount: refined ? filteredFeedback.length : active.totalCount,
    isPartialWindow: refined ? active.hasMore : active.isPartialWindow,
    hasMore: active.hasMore,
    loadedCount: refined ? active.items.length : null,
    loadMore: active.loadMore,
    isLoadingMore: active.isLoadingMore,
    failure: active.failure,
  }
}

/** `{ next_token }` for a later page, nothing for the first. */
function cursorParam(pageParam: string): { next_token?: string } {
  return pageParam ? { next_token: pageParam } : {}
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
  /** The active read failed with nothing to show: not the same as "no feedback found". */
  failure: FailedReads
}

/** Structural subset of UseInfiniteQueryResult — keeps the generics out of the hook. */
interface InfiniteQuery<Page> extends RetryableRead {
  data: { pages: Page[] } | undefined
  isLoading: boolean
  hasNextPage: boolean
  isFetchingNextPage: boolean
  fetchNextPage: () => Promise<unknown>
}

function pagingOf<Page extends { items?: FeedbackItem[] }>(query: InfiniteQuery<Page>) {
  const pages = query.data?.pages ?? []
  return {
    pages,
    items: pages.flatMap((page) => page.items ?? []),
    isLoading: query.isLoading,
    hasMore: query.hasNextPage,
    loadMore: () => {
      void query.fetchNextPage()
    },
    isLoadingMore: query.isFetchingNextPage,
    failure: failedReads([query]),
  }
}

/**
 * Totals of a cursor-paged read. The FIRST page carries the window `total`
 * (later pages answer `null`); when the route could not count it, the loaded
 * rows are a lower bound while more pages remain ("N+").
 */
function toCursorSource(query: InfiniteQuery<CursorPage>): ActiveFeedbackSource {
  const { pages, ...paging } = pagingOf(query)
  const first = pages.at(0)
  const partialScan = pages.some((page) => page.is_partial_window === true)
  const total = first?.total
  return {
    ...paging,
    totalCount: total ?? paging.items.length,
    isPartialWindow: partialScan || (total == null && paging.hasMore),
  }
}

function toListSource(query: InfiniteQuery<FeedbackPage>): ActiveFeedbackSource {
  const { pages, ...paging } = pagingOf(query)
  const lastPage = pages.at(-1)
  return {
    ...paging,
    totalCount: lastPage?.total ?? lastPage?.count ?? 0,
    isPartialWindow: lastPage?.is_partial_window ?? false,
  }
}

interface ActiveQueries {
  searchQuery: InfiniteQuery<CursorPage>
  urgentQuery: InfiniteQuery<CursorPage>
  listQuery: InfiniteQuery<FeedbackPage>
}

function pickActiveSource(
  isSearching: boolean,
  showUrgentOnly: boolean,
  queries: ActiveQueries
): ActiveFeedbackSource {
  if (isSearching) return toCursorSource(queries.searchQuery)
  if (showUrgentOnly) return toCursorSource(queries.urgentQuery)
  return toListSource(queries.listQuery)
}
