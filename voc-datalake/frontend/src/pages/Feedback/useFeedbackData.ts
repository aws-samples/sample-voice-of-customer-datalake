/**
 * @fileoverview Paginated feedback data fetching hook.
 * @module pages/Feedback/useFeedbackData
 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import type { FeedbackItem } from '../../api/types'

export const PAGE_SIZE = 24

function extractTotal(data: {
  count?: number
  items?: unknown[]
} | undefined): number {
  if (data == null) return 0
  // getFeedback returns { total }, getUrgentFeedback returns { count }
  if ('total' in data) {
    const val = data.total
    if (typeof val === 'number') return val
  }
  return data.count ?? 0
}

function buildFilterParams(
  sourceFilter: string,
  sentimentFilter: string,
  categoryFilter: string,
) {
  return {
    source: sourceFilter === 'all' ? undefined : sourceFilter,
    sentiment: sentimentFilter === 'all' ? undefined : sentimentFilter,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
  }
}

export interface FeedbackPageData {
  items: FeedbackItem[]
  total: number
}

export interface FeedbackDataResult {
  data: FeedbackPageData | undefined
  isLoading: boolean
  isFetchingMore: boolean
  hasMore: boolean
  loadMore: () => void
}

export interface FeedbackDataParams {
  hasApiEndpoint: boolean
  days: number
  search: string
  sourceFilter: string
  sentimentFilter: string
  categoryFilter: string
  showUrgentOnly: boolean
}

const noopLoadMore = () => {}

function emptyResult(isLoading: boolean): FeedbackDataResult {
  return {
    data: undefined,
    isLoading,
    isFetchingMore: false,
    hasMore: false,
    loadMore: noopLoadMore,
  }
}

function useSearchFeedback(params: FeedbackDataParams): FeedbackDataResult {
  const {
    hasApiEndpoint, days, search, sourceFilter, sentimentFilter, categoryFilter,
  } = params
  const filters = buildFilterParams(sourceFilter, sentimentFilter, categoryFilter)

  const query = useQuery({
    queryKey: ['feedback-search', search, days, sourceFilter, sentimentFilter, categoryFilter],
    queryFn: () => api.searchFeedback({
      q: search,
      days,
      limit: PAGE_SIZE,
      ...filters,
    }),
    enabled: hasApiEndpoint,
  })

  if (query.data == null) {
    return emptyResult(query.isLoading)
  }

  return {
    data: {
      items: query.data.items,
      total: query.data.count,
    },
    isLoading: query.isLoading,
    isFetchingMore: false,
    hasMore: false,
    loadMore: noopLoadMore,
  }
}

function buildQueryFn(
  showUrgentOnly: boolean,
  days: number,
  filters: ReturnType<typeof buildFilterParams>,
) {
  if (showUrgentOnly) {
    return () => api.getUrgentFeedback({
      days,
      limit: PAGE_SIZE,
      ...filters,
    })
  }
  return () => api.getFeedback({
    days,
    limit: PAGE_SIZE,
    offset: 0,
    ...filters,
  })
}

function usePaginatedFeedback(params: FeedbackDataParams): FeedbackDataResult {
  const {
    hasApiEndpoint, days, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly,
  } = params
  const filters = buildFilterParams(sourceFilter, sentimentFilter, categoryFilter)

  const [extraItems, setExtraItems] = useState<FeedbackItem[]>([])
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  const [activeFilterKey, setActiveFilterKey] = useState('')

  const filterKey = `${days}-${sourceFilter}-${sentimentFilter}-${categoryFilter}-${showUrgentOnly}`
  const filtersChanged = activeFilterKey !== filterKey
  if (filtersChanged) {
    setActiveFilterKey(filterKey)
    setExtraItems([])
  }

  const query = useQuery({
    queryKey: ['feedback', days, sourceFilter, sentimentFilter, categoryFilter, showUrgentOnly],
    queryFn: buildQueryFn(showUrgentOnly, days, filters),
    enabled: hasApiEndpoint,
  })

  const initialItems: FeedbackItem[] = query.data?.items ?? []
  const totalCount = extractTotal(query.data)
  const allItems = extraItems.length > 0 ? [...initialItems, ...extraItems] : initialItems

  const loadMore = () => {
    if (isFetchingMore || allItems.length >= totalCount) return
    setIsFetchingMore(true)
    void api.getFeedback({
      days,
      limit: PAGE_SIZE,
      offset: allItems.length,
      ...buildFilterParams(sourceFilter, sentimentFilter, categoryFilter),
    }).then((result) => {
      setExtraItems((prev) => [...prev, ...result.items])
      return null
    }).catch(() => null)
      .finally(() => {
        setIsFetchingMore(false)
      })
  }

  if (query.data == null) {
    return emptyResult(query.isLoading)
  }

  return {
    data: {
      items: allItems,
      total: totalCount,
    },
    isLoading: query.isLoading,
    isFetchingMore,
    hasMore: allItems.length < totalCount,
    loadMore,
  }
}

export function useFeedbackData(params: FeedbackDataParams): FeedbackDataResult {
  const isSearching = params.search.length >= 2
  const searchResult = useSearchFeedback(params)
  const paginatedResult = usePaginatedFeedback(params)

  if (isSearching) return searchResult
  return paginatedResult
}
