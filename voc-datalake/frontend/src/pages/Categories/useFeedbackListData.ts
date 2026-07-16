/**
 * @fileoverview Feedback list data for the Categories page.
 *
 * Chooses the right endpoint for the current filters — server-side search
 * (`/feedback/search`) when a query of 2+ chars is present, urgent-only
 * (`/feedback/urgent`) when the toggle is on, otherwise the regular list
 * (`/feedback`) — and applies the client-side refinements (min rating,
 * multi-category, keyword match) the server doesn't support.
 *
 * @module pages/Categories/useFeedbackListData
 */

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams, FeedbackItem } from '../../api/client'
import type { CategoryFiltersState } from './useCategoryFilters'

const PAGE_LIMIT = 100
export const SEARCH_MIN_CHARS = 2

interface FeedbackResponse {
  items?: FeedbackItem[]
  count?: number
  total?: number
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
  shouldFetchFeedback: boolean
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
  if (filters.minRating > 0 && (!item.rating || item.rating < filters.minRating)) return false
  if (filters.selectedCategories.length > 1 && !filters.selectedCategories.includes(item.category)) return false
  if (filters.selectedKeywords.length > 0) {
    const text = `${item.original_text} ${item.problem_summary ?? ''}`.toLowerCase()
    if (!filters.selectedKeywords.some((kw) => text.includes(kw.toLowerCase()))) return false
  }
  return true
}

function computeShouldFetch(filters: CategoryFiltersState, isSearching: boolean): boolean {
  return (
    filters.selectedCategories.length > 0 ||
    filters.selectedKeywords.length > 0 ||
    filters.showAll ||
    filters.showUrgentOnly ||
    isSearching
  )
}

/** Exactly one of the three queries is enabled for any given filter state. */
function computeEnabledQueries(
  apiEndpoint: string,
  shouldFetch: boolean,
  isSearching: boolean,
  showUrgentOnly: boolean
): { search: boolean; urgent: boolean; list: boolean } {
  const anyEnabled = !!apiEndpoint && shouldFetch
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
  const shouldFetchFeedback = computeShouldFetch(filters, isSearching)
  const enabled = computeEnabledQueries(apiEndpoint, shouldFetchFeedback, isSearching, filters.showUrgentOnly)
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

  const listQuery = useQuery({
    queryKey: ['categories-feedback', commonParams],
    queryFn: () => api.getFeedback(commonParams),
    enabled: enabled.list,
  })

  const active = pickActiveQuery(isSearching, filters.showUrgentOnly, { searchQuery, urgentQuery, listQuery })

  const filteredFeedback = useMemo(() => {
    const items = active.data?.items ?? []
    return items.filter((item) => matchesClientFilters(item, filters))
  }, [active.data, filters])

  return {
    filteredFeedback,
    isLoading: active.isLoading,
    isSearching,
    ...extractTotals(active.data),
    shouldFetchFeedback,
  }
}

interface ActiveQueries {
  searchQuery: { data: FeedbackResponse | undefined; isLoading: boolean }
  urgentQuery: { data: FeedbackResponse | undefined; isLoading: boolean }
  listQuery: { data: FeedbackResponse | undefined; isLoading: boolean }
}

function pickActiveQuery(
  isSearching: boolean,
  showUrgentOnly: boolean,
  queries: ActiveQueries
): { data: FeedbackResponse | undefined; isLoading: boolean } {
  if (isSearching) return queries.searchQuery
  if (showUrgentOnly) return queries.urgentQuery
  return queries.listQuery
}
