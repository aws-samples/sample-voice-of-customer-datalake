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
 * Keeping the key and the fetcher in one place makes that invariant structural
 * rather than a convention two files have to remember. Any future parameter has
 * to be threaded through here, so it lands in the key and the request together.
 *
 * @module hooks/useSummaryQuery
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import type { DateRangeParams } from '../api/client'

/** Query key for the summary of a given window. Single source of truth. */
export const summaryQueryKey = (dateParams: DateRangeParams) =>
  ['summary', dateParams] as const

/**
 * Fetch the metrics summary for `dateParams`.
 *
 * @param dateParams window descriptor from `getDateRangeParams`
 * @param apiEndpoint configured endpoint; the query is disabled while empty
 */
export function useSummaryQuery(dateParams: DateRangeParams, apiEndpoint: string) {
  return useQuery({
    queryKey: summaryQueryKey(dateParams),
    queryFn: () => api.getSummary(dateParams),
    enabled: apiEndpoint.length > 0,
  })
}
