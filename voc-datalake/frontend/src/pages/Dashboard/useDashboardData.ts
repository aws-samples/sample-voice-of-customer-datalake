/**
 * @fileoverview The Dashboard's reads, narrowed by its facet filters (source, category,
 * sentiment, usefulness; `api/feedbackFacets.ts`).
 *
 * Every read sends the same facet params, so the cards, charts and urgent list count one
 * set of reviews. With no facet set each key is exactly the unfiltered one other features
 * share (the sidebar badge's summary, the source / category reads), so an unfiltered
 * Dashboard asks nothing twice. The filter OPTIONS come from the unfiltered source and
 * category breakdowns, so choosing a value never hides the others. Ported from PR #429's
 * `useDashboardData` (@aws-bryan).
 *
 * @module pages/Dashboard/useDashboardData
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams } from '../../api/client'
import { facetQueryParams, facetsKey, hasActiveFacets } from '../../api/feedbackFacets'
import type { FacetQueryParams, FeedbackFacets } from '../../api/feedbackFacets'
import { metricsKeys } from '../../api/queryKeys'
import { useSummaryQuery } from '../../hooks/useSummaryQuery'
import { URGENT_PREVIEW_LIMIT } from './DashboardSections'

/** What the facets add to a read's key: nothing when none is set (the shared unfiltered key), else their stable form. */
function facetKeyPart(facets: FeedbackFacets): string[] {
  return hasActiveFacets(facets) ? [facetsKey(facets)] : []
}

/** A read's key: the unfiltered key, plus {@link facetKeyPart}. */
function withFacets(key: readonly unknown[], facets: FeedbackFacets): readonly unknown[] {
  return [...key, ...facetKeyPart(facets)]
}

/**
 * A breakdown read twice: unfiltered (the filter options; the key other features share) and,
 * only while a facet is set, narrowed. `shown` is what the chart draws.
 */
function useFacetedRead<T>(
  key: readonly unknown[], facets: FeedbackFacets, enabled: boolean, fetch: (filters: FacetQueryParams) => Promise<T>,
) {
  const filtered = hasActiveFacets(facets)
  const all = useQuery({ queryKey: key, queryFn: () => fetch({}), enabled })
  const narrowed = useQuery({
    queryKey: withFacets(key, facets),
    queryFn: () => fetch(facetQueryParams(facets)),
    enabled: enabled && filtered,
  })
  return { all: all.data, shown: filtered ? narrowed.data : all.data }
}

export function useDashboardData(dateParams: DateRangeParams, apiEndpoint: string, facets: FeedbackFacets) {
  const enabled = !!apiEndpoint
  const filters = facetQueryParams(facets)

  const summaryQuery = useSummaryQuery(dateParams, apiEndpoint, facets)

  const { data: sentiment } = useQuery({
    queryKey: withFacets(metricsKeys.sentiment(dateParams), facets),
    queryFn: () => api.getSentiment(dateParams, undefined, filters),
    enabled,
  })
  const categories = useFacetedRead(metricsKeys.categories(dateParams), facets, enabled,
    (narrowed) => api.getCategories(dateParams, undefined, narrowed))
  const sources = useFacetedRead(metricsKeys.sources(dateParams), facets, enabled,
    (narrowed) => api.getSources(dateParams, narrowed))
  // `limit` MUST stay in the query key: /feedback/urgent returns a different
  // payload per limit, so a key that omits it lets two callers with different
  // limits collide on one cache entry (which is how the sidebar badge used to
  // render this list's page size).
  const { data: urgentFeedback } = useQuery({
    queryKey: ['urgent', dateParams, URGENT_PREVIEW_LIMIT, ...facetKeyPart(facets)],
    queryFn: () => api.getUrgentFeedback({ ...dateParams, limit: URGENT_PREVIEW_LIMIT, ...filters }),
    enabled,
  })

  return {
    summaryQuery,
    sentiment,
    categories: categories.shown,
    sources: sources.shown,
    urgentFeedback,
    /** The filter options: every source and category of the window, unfiltered. */
    sourceOptions: Object.keys(sources.all?.sources ?? {}),
    categoryOptions: Object.keys(categories.all?.categories ?? {}),
  }
}
