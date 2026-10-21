/**
 * @fileoverview The Dashboard's summary read WITH the empty-window fallback
 * folded in, so the page component carries one call instead of the
 * selected-summary / probe / effective-summary / pick dance.
 *
 * Pulling this into a hook keeps the Dashboard function under its complexity
 * budget and puts the fallback wiring beside `useSummaryQuery` (whose shared
 * cache entry it reuses) and `useEmptyWindowFallback` (whose decision it
 * applies).
 *
 * @module hooks/useDashboardSummary
 */
import { useSummaryQuery } from './useSummaryQuery'
import { useEmptyWindowFallback } from './useEmptyWindowFallback'
import type { EmptyWindowFallback } from './useEmptyWindowFallback'
import type { DateRangeParams, DateBasis, MetricsSummary } from '../api/client'

export interface DashboardSummaryResult {
  /** The summary the page renders — fallback window's when active, else selected. */
  summary: MetricsSummary | undefined
  /** Window the page's other queries should use (widened only during a fallback). */
  effectiveDateParams: DateRangeParams
  /** Banner descriptor, or null when no fallback is in effect. */
  fallback: EmptyWindowFallback | null
  /** True while the selected summary loads OR the fallback probe is resolving. */
  isLoading: boolean
}

/**
 * Resolve the Dashboard summary, falling back to the most recent data when the
 * selected window is empty.
 *
 * @param dateParams  the user's selected window
 * @param dateBasis   the basis the page filters on
 * @param apiEndpoint configured endpoint; gates every query
 */
export function useDashboardSummary(
  dateParams: DateRangeParams,
  dateBasis: DateBasis,
  apiEndpoint: string | undefined,
): DashboardSummaryResult {
  // Shared with the sidebar urgent badge via useSummaryQuery so the two cannot
  // resolve to different cache entries (see that module).
  const { data: selectedSummary, isLoading: summaryLoading } = useSummaryQuery(dateParams, apiEndpoint)

  const selectedEmpty = (selectedSummary?.total_feedback ?? 0) === 0
  const { effectiveDateParams, fallback, isResolving } = useEmptyWindowFallback(
    dateParams, selectedEmpty, summaryLoading, apiEndpoint, dateBasis,
  )

  // The summary at the effective window. With no fallback this resolves to the
  // same key as the call above (shared cache entry, no extra fetch); during a
  // fallback it fetches the most-recent-data summary. Enabled only while a
  // fallback is active so the non-fallback path issues exactly one summary read.
  const { data: effectiveSummary } = useSummaryQuery(
    effectiveDateParams,
    fallback ? apiEndpoint : undefined,
  )

  return {
    summary: fallback ? effectiveSummary : selectedSummary,
    effectiveDateParams,
    fallback,
    isLoading: summaryLoading || isResolving,
  }
}
