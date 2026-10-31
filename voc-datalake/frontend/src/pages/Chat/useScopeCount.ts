/**
 * @fileoverview The live size of the /chat panel's scope: how many reviews the filters match in
 * the current time window.
 *
 * Read from `GET /metrics/sentiment`, the one existing count route that takes every filter the
 * panel offers (source, categories, the item filters: channel / tag / dims / rating / urgent) and
 * answers per sentiment. Several categories are ONE call (`category=a,b` is any of them, 5.62), and
 * a sentiment filter picks its bucket. `is_partial` makes the number a lower bound.
 *
 * @module pages/Chat/useScopeCount
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import type { ItemFilterParams, SentimentBreakdown } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import type { ScopeFilters } from '../../assistant/store/chatScopeStore'
import { ratingParamsOf } from '../Categories/useCategoryFilters'
import type { RatingFilter } from '../Categories/types'

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

/** `rating` (+ `rating_dir=below`) as the Categories picker's state: a whole 1-5 star bound, else any (0). */
function ratingFilterOf(filters: ScopeFilters): RatingFilter {
  const stars = Number(filters.rating)
  const valid = Number.isInteger(stars) && stars >= MIN_STARS && stars <= MAX_STARS
  return { value: valid ? stars : 0, direction: filters.rating_dir === 'below' ? 'below' : 'up' }
}

/** The scope's item filters as the routes' query parameters (the Categories page's own mapping). */
function itemFiltersOf(filters: ScopeFilters): ItemFilterParams {
  return {
    ...(filters.channel === undefined ? {} : { channel: filters.channel }),
    ...(filters.tag === undefined ? {} : { tag: filters.tag }),
    ...(filters.dims === undefined ? {} : { dims: filters.dims }),
    ...ratingParamsOf(ratingFilterOf(filters)),
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
  const category = categories.length > 0 ? categories.join(',') : undefined
  const itemFilters = itemFiltersOf(filters)
  const query = useQuery({
    queryKey: ['chat-scope-count', range, filters.source, category, itemFilters],
    queryFn: () => api.getSentiment(range, filters.source, itemFilters, category),
    enabled,
    placeholderData: keepPreviousData,
  })
  return {
    total: countOf(query.data, filters.sentiment),
    isPartial: query.data?.is_partial === true,
    isLoading: query.isLoading,
    isError: query.isError,
  }
}
