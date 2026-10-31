/**
 * @fileoverview The live size of the /chat panel's scope: how many reviews the filters match in
 * the current time window.
 *
 * Read from `GET /metrics/sentiment`, the one existing count route that takes every filter the
 * panel offers (source, one category, the item filters: channel / tag / dims / rating / urgent)
 * and answers per sentiment. A sentiment filter picks its bucket; several categories are one call
 * each, summed (a review has one category, so the sets do not overlap). `is_partial` on any call
 * makes the number a lower bound.
 *
 * @module pages/Chat/useScopeCount
 */
import { keepPreviousData, useQueries } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import type { ItemFilterParams, SentimentBreakdown } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import type { ScopeFilters } from '../../assistant/store/chatScopeStore'

export interface ScopeCount {
  readonly total: number
  readonly isPartial: boolean
  readonly isLoading: boolean
  readonly isError: boolean
}

/** A comma list (`a,b`) as trimmed values. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter((part) => part !== '')
}

const MIN_STARS = 1
const MAX_STARS = 5
const URGENT_ONLY: NonNullable<ItemFilterParams['urgent']> = 1

/** `rating` (+ `rating_dir=below`) as the routes' whole-star bound; anything else is any rating. */
function ratingParamsOf(filters: ScopeFilters): Pick<ItemFilterParams, 'rating_min' | 'rating_max'> {
  const stars = Number(filters.rating)
  if (!Number.isInteger(stars) || stars < MIN_STARS || stars > MAX_STARS) return {}
  return filters.rating_dir === 'below' ? { rating_max: stars } : { rating_min: stars }
}

/** The scope's item filters as the routes' query parameters (the Categories page's own mapping). */
export function itemFiltersOf(filters: ScopeFilters): ItemFilterParams {
  return {
    ...(filters.channel === undefined ? {} : { channel: filters.channel }),
    ...(filters.tag === undefined ? {} : { tag: filters.tag }),
    ...(filters.dims === undefined ? {} : { dims: filters.dims }),
    ...ratingParamsOf(filters),
    ...(filters.urgent === '1' ? { urgent: URGENT_ONLY } : {}),
  }
}

function countOf(body: SentimentBreakdown | undefined, sentiment: string | undefined): number {
  if (body === undefined) return 0
  return sentiment === undefined ? body.total : body.breakdown[sentiment] ?? 0
}

export function useScopeCount(filters: ScopeFilters, enabled: boolean): ScopeCount {
  const { timeRange, customDays, dateBasis } = useConfigStore()
  const range = getDateRangeParams(timeRange, customDays, dateBasis)
  const categories = splitList(filters.category)
  const itemFilters = itemFiltersOf(filters)
  const queries = useQueries({
    queries: (categories.length > 0 ? categories : [undefined]).map((category) => ({
      queryKey: ['chat-scope-count', range, filters.source, category, itemFilters],
      queryFn: () => api.getSentiment(range, filters.source, itemFilters, category),
      enabled,
      placeholderData: keepPreviousData,
    })),
  })
  return {
    total: queries.reduce((sum, query) => sum + countOf(query.data, filters.sentiment), 0),
    isPartial: queries.some((query) => query.data?.is_partial === true),
    isLoading: queries.some((query) => query.isLoading),
    isError: queries.some((query) => query.isError),
  }
}
