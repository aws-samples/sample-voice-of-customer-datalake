/**
 * @fileoverview Every query behind the Dashboard, for the current filters.
 *
 * Two paths with one result shape:
 * - **No filters**: the exact pre-computed aggregates (`/metrics/summary|sentiment|
 *   categories|sources`) plus the empty-window fallback, as before.
 * - **Filters active**: one `/metrics/overview` scan of the window, which is the
 *   only way to answer a sentiment/usefulness/custom-field question. No fallback:
 *   a filtered window that matches nothing is an honest empty answer.
 *
 * Both paths' hooks are always called (hooks cannot be conditional); each is
 * disabled while the other path is active. The urgent preview and the filter
 * options are fetched on both paths.
 *
 * @module pages/Dashboard/useDashboardData
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type {
  CategoryBreakdown, DateBasis, DateRangeParams, FeedbackItem, MetricsSummary, SentimentBreakdown, SourceBreakdown,
} from '../../api/client'
import { filtersKey, hasActiveFilters, toFeedbackQueryParams } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { getMetricsOverview } from '../../api/metricsOverviewApi'
import { useDashboardSummary } from '../../hooks/useDashboardSummary'
import type { EmptyWindowFallback } from '../../hooks/useEmptyWindowFallback'

/** How many urgent items the dashboard previews (a preview, never a count). */
export const URGENT_PREVIEW_LIMIT = 5

/** Upper bound on distinct sources/categories the entities call returns for the panel. */
const FILTER_OPTIONS_LIMIT = 100

interface Breakdowns {
  summary: MetricsSummary | undefined
  sentiment: SentimentBreakdown | undefined
  categories: CategoryBreakdown | undefined
  sources: SourceBreakdown | undefined
  fallback: EmptyWindowFallback | null
  isLoading: boolean
  /**
   * The filtered scan failed, so its empty breakdowns are UNKNOWN rather than
   * zero and must not read as "nothing matches". Always false on the aggregate
   * path, which keeps its existing behaviour.
   */
  loadFailed: boolean
  /** Re-run the failed filtered scan (no-op on the aggregate path). */
  retry: () => void
  /**
   * The breakdowns shown belong to an EARLIER selection while the current one
   * loads — the page dims them instead of blanking to a spinner.
   */
  isUpdating: boolean
  /** The window the shared queries should read (widened during a fallback). */
  windowParams: DateRangeParams
}

export interface DashboardData extends Omit<Breakdowns, 'windowParams'> {
  urgentItems: FeedbackItem[] | undefined
  /** Options for the filter panel: every source/category in the window, with counts. */
  optionCounts: { sources: Record<string, number>; categories: Record<string, number> }
  isFiltered: boolean
}

/** The unfiltered path; `apiEndpoint` undefined disables it. */
function useAggregateBreakdowns(
  dateParams: DateRangeParams, dateBasis: DateBasis, apiEndpoint: string | undefined,
): Breakdowns {
  const enabled = apiEndpoint !== undefined
  const base = useDashboardSummary(dateParams, dateBasis, apiEndpoint)
  const windowParams = base.effectiveDateParams
  const { data: sentiment } = useQuery({
    queryKey: ['sentiment', windowParams], queryFn: () => api.getSentiment(windowParams), enabled,
  })
  const { data: categories } = useQuery({
    queryKey: ['categories', windowParams], queryFn: () => api.getCategories(windowParams), enabled,
  })
  const { data: sources } = useQuery({
    queryKey: ['sources', windowParams], queryFn: () => api.getSources(windowParams), enabled,
  })
  return {
    summary: base.summary, sentiment, categories, sources,
    fallback: base.fallback, isLoading: base.isLoading, loadFailed: false, retry: () => undefined,
    isUpdating: false, windowParams,
  }
}

/** The filtered path: one overview scan. */
function useFilteredBreakdowns(
  dateParams: DateRangeParams, filters: FeedbackFilterState, enabled: boolean,
): Breakdowns {
  const { data, isLoading, isError, isPlaceholderData, refetch } = useQuery({
    queryKey: ['metrics-overview', dateParams, filtersKey(filters)],
    queryFn: () => getMetricsOverview(dateParams, filters),
    enabled,
    // Changing one filter keeps the previous selection's numbers on screen
    // (dimmed) until the new scan lands, instead of dropping back to "loading".
    placeholderData: keepPreviousData,
  })
  return {
    summary: data?.summary, sentiment: data?.sentiment, categories: data?.categories, sources: data?.sources,
    fallback: null, isLoading, loadFailed: isError && data === undefined,
    retry: () => void refetch(), isUpdating: isPlaceholderData, windowParams: dateParams,
  }
}

/**
 * The breakdowns to show. On the FIRST filter of a session the overview has no
 * previous result to keep, so the unfiltered numbers stay up (flagged as
 * updating) rather than blanking the page; the aggregate queries are disabled
 * on this path but still return what they already cached.
 */
function pickActive(isFiltered: boolean, filtered: Breakdowns, aggregate: Breakdowns): Breakdowns {
  if (!isFiltered) return aggregate
  const firstScanInFlight = filtered.isLoading && aggregate.summary !== undefined
  if (firstScanInFlight) return { ...aggregate, fallback: null, isLoading: false, isUpdating: true }
  return filtered
}

export function useDashboardData(
  dateParams: DateRangeParams,
  dateBasis: DateBasis,
  apiEndpoint: string,
  filters: FeedbackFilterState,
): DashboardData {
  const isFiltered = hasActiveFilters(filters)
  const configured = apiEndpoint !== ''
  const aggregate = useAggregateBreakdowns(dateParams, dateBasis, configured && !isFiltered ? apiEndpoint : undefined)
  const filtered = useFilteredBreakdowns(dateParams, filters, configured && isFiltered)
  const { windowParams, ...active } = pickActive(isFiltered, filtered, aggregate)

  // `limit` stays in the key: /feedback/urgent returns a different payload per
  // limit, and a key without it lets two callers collide on one cache entry.
  const { data: urgent } = useQuery({
    queryKey: ['urgent', windowParams, URGENT_PREVIEW_LIMIT, filtersKey(filters)],
    queryFn: () => api.getUrgentFeedback({ ...windowParams, limit: URGENT_PREVIEW_LIMIT, ...toFeedbackQueryParams(filters) }),
    enabled: configured,
    placeholderData: keepPreviousData,
  })
  // Kept across window changes too, so the panel's option lists never empty
  // out under the user's cursor while a new window loads.
  const { data: entities } = useQuery({
    queryKey: ['entities', windowParams, FILTER_OPTIONS_LIMIT],
    queryFn: () => api.getEntities({ ...windowParams, limit: FILTER_OPTIONS_LIMIT }),
    enabled: configured,
    placeholderData: keepPreviousData,
  })

  return {
    ...active,
    urgentItems: urgent?.items,
    optionCounts: {
      sources: entities?.entities.sources ?? {},
      categories: entities?.entities.categories ?? {},
    },
    isFiltered,
  }
}
