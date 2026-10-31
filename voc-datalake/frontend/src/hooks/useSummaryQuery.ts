/**
 * @fileoverview Shared `/metrics/summary` query.
 *
 * Two components observe the same summary: the Dashboard (metric cards, charts)
 * and the sidebar urgent badge in Layout. They MUST resolve to one cache entry,
 * otherwise the badge and the Dashboard's "Urgent Issues" card can display
 * different values for the same window — which is exactly the defect this hook
 * was extracted to prevent, in its previous incarnation on `/feedback/urgent`
 * (two callers, identical query key, different `limit`, so each rendered
 * whichever response resolved last).
 *
 * Home's metric tiles read the 7-day and 14-day summaries; under the default
 * time range (14 days by imported date) the shell reads the second one:
 * `useSummaryQuery({ days: 14 }, …)` is exactly the entry
 * `getDateRangeParams('14d')` yields, so that is one request, not two (they used
 * to fetch it under a second key, `brief-tiles`).
 * The key is in the `feedbackData` cache family (api/queryPolicies.ts): reused
 * for 5 minutes and not refetched when the tab regains focus.
 *
 * Keeping the key and the fetcher in one place makes that invariant structural
 * rather than a convention two files have to remember. Any future parameter has
 * to be threaded through here, so it lands in the key and the request together.
 *
 * @module hooks/useSummaryQuery
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DateRangeParams } from '../api/client'
import { EMPTY_FACETS, facetQueryParams, facetsKey, hasActiveFacets } from '../api/feedbackFacets'
import type { FeedbackFacets } from '../api/feedbackFacets'

/**
 * Query key for the summary of a given window. Single source of truth. The unfiltered key
 * stays `['summary', dateParams]` (the sidebar badge's); facets add their stable form.
 */
const summaryQueryKey = (dateParams: DateRangeParams, facets: FeedbackFacets) =>
  hasActiveFacets(facets) ? ['summary', dateParams, facetsKey(facets)] as const : ['summary', dateParams] as const

/**
 * Fetch the metrics summary for `dateParams`.
 *
 * @param dateParams window descriptor from `getDateRangeParams`
 * @param apiEndpoint configured endpoint; the query stays disabled while unset.
 *   Typed as optional and tested for truthiness rather than length, because the
 *   store is rehydrated from persisted localStorage: an older persisted shape can
 *   deliver `undefined` here regardless of the declared type, and `.length` on
 *   that would throw.
 * @param facets the Dashboard's source / category / sentiment / usefulness filters (none = unfiltered)
 */
export function useSummaryQuery(
  dateParams: DateRangeParams, apiEndpoint: string | undefined, facets: FeedbackFacets = EMPTY_FACETS,
) {
  return useQuery({
    queryKey: summaryQueryKey(dateParams, facets),
    queryFn: () => api.getSummary(dateParams, undefined, facetQueryParams(facets)),
    enabled: !!apiEndpoint,
  })
}

