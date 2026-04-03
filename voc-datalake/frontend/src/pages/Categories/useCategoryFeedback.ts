/**
 * @fileoverview Paginated feedback hook for the Categories page.
 * @module pages/Categories/useCategoryFeedback
 */

import { useQuery } from '@tanstack/react-query'
import {
  useState, useMemo,
} from 'react'
import { api } from '../../api/client'
import type { SentimentFilter } from './types'
import type { FeedbackItem } from '../../api/types'

function buildQueryParams(params: {
  days: number
  selectedSource: string | null
  selectedCategories: string[]
  sentimentFilter: SentimentFilter
  offset?: number
}) {
  return {
    days: params.days,
    source: params.selectedSource ?? undefined,
    category: params.selectedCategories.length > 0 ? params.selectedCategories.join(',') : undefined,
    sentiment: params.sentimentFilter === 'all' ? undefined : params.sentimentFilter,
    limit: 50,
    offset: params.offset ?? 0,
  }
}

export interface CategoryFeedbackParams {
  days: number
  selectedSource: string | null
  selectedCategories: string[]
  selectedKeywords: string[]
  sentimentFilter: SentimentFilter
  enabled: boolean
}

export function useCategoryFeedback(params: CategoryFeedbackParams) {
  const {
    days, selectedSource, selectedCategories, selectedKeywords, sentimentFilter, enabled,
  } = params
  const [extraItems, setExtraItems] = useState<FeedbackItem[]>([])
  const [isFetchingMore, setIsFetchingMore] = useState(false)
  const [activeKey, setActiveKey] = useState('')

  const shouldFetch = selectedCategories.length > 0 || selectedKeywords.length > 0
  const filterKey = `${days}-${selectedCategories.join(',')}-${sentimentFilter}-${selectedSource}`
  if (activeKey !== filterKey) {
    setActiveKey(filterKey)
    if (extraItems.length > 0) {
      setExtraItems([])
    }
  }

  const query = useQuery({
    queryKey: ['feedback', days, selectedCategories, sentimentFilter, selectedKeywords, selectedSource],
    queryFn: () => api.getFeedback(
      buildQueryParams({
        days,
        selectedSource,
        selectedCategories,
        sentimentFilter,
      }),
    ),
    enabled: enabled && shouldFetch,
  })

  const allItems = useMemo(() => {
    const initial: FeedbackItem[] = query.data?.items ?? []
    return extraItems.length > 0 ? [...initial, ...extraItems] : initial
  }, [query.data, extraItems])

  const total = Number(query.data?.total ?? query.data?.count ?? 0)
  const hasMore = allItems.length < total

  const loadMore = () => {
    if (isFetchingMore || !hasMore) return
    setIsFetchingMore(true)
    void api.getFeedback(
      buildQueryParams({
        days,
        selectedSource,
        selectedCategories,
        sentimentFilter,
        offset: allItems.length,
      }),
    ).then((result) => {
      setExtraItems((prev) => [...prev, ...result.items])
      return null
    }).catch(() => null)
      .finally(() => {
        setIsFetchingMore(false)
      })
  }

  return {
    allItems,
    total,
    isLoading: query.isLoading,
    shouldFetch,
    hasMore,
    isFetchingMore,
    loadMore,
  }
}
