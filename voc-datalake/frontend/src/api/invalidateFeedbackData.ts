/**
 * @fileoverview Refresh every cached view of customer feedback after a write that
 * moves it: an import, a reprocess, an erasure, a source-policy or access change,
 * a category or dimension correction.
 *
 * The family is the queryPolicies `feedbackData` family (metrics, feedback lists
 * and detail, Radar data), matched by predicate, so a new feedback query is
 * covered the moment it is classified there. Invalidation marks every match
 * stale and refetches only the ones on screen; the rest refetch on their next
 * mount instead of serving a 5-minute-old answer.
 *
 * Imports go through the processing queue (enrichment takes seconds to a
 * minute), so `afterIngest` repeats the refresh twice while the new reviews land.
 *
 * @module api/invalidateFeedbackData
 */
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { ROOT_FAMILIES, cacheFamilyOf } from './queryPolicies'

type FeedbackDataScope = 'all' | 'radar'

export interface InvalidateFeedbackDataOptions {
  /** `radar` refreshes only the Radar views (a Radar brand save); default `all`. */
  readonly scope?: FeedbackDataScope
  /** Also refresh again after {@link INGEST_FOLLOW_UPS_MS}: the write was queued for processing. */
  readonly afterIngest?: boolean
}

/** When an import's reviews usually land: the processor enriches a small batch within a minute. */
export const INGEST_FOLLOW_UPS_MS: readonly number[] = [20_000, 60_000]

/** The roots of the family, from the one classification table. */
const FEEDBACK_ROOTS: readonly string[] = Object.entries(ROOT_FAMILIES)
  .filter(([, family]) => family === 'feedbackData').map(([root]) => root)

function inScope(queryKey: readonly unknown[], scope: FeedbackDataScope): boolean {
  // Radar brands are config (queryPolicies), so the family test alone keeps them out.
  return cacheFamilyOf(queryKey) === 'feedbackData' && (scope === 'all' || queryKey[0] === 'radar')
}

/** One call per root (prefix match), each narrowed by the family predicate (sub-keys such as Radar brands). */
async function invalidateNow(queryClient: QueryClient, scope: FeedbackDataScope): Promise<void> {
  const roots = scope === 'radar' ? ['radar'] : FEEDBACK_ROOTS
  await Promise.all(roots.map((root) => queryClient.invalidateQueries({
    queryKey: [root],
    predicate: (query) => inScope(query.queryKey, scope),
  })))
}

/** Invalidate the feedback/metrics/Radar family (see the module doc). */
export async function invalidateFeedbackData(
  queryClient: QueryClient,
  options: InvalidateFeedbackDataOptions = {},
): Promise<void> {
  const scope = options.scope ?? 'all'
  if (options.afterIngest === true) {
    for (const delay of INGEST_FOLLOW_UPS_MS) setTimeout(() => void invalidateNow(queryClient, scope), delay)
  }
  await invalidateNow(queryClient, scope)
}

/** The same, bound to the app's QueryClient — what a page or modal calls after its write succeeds. */
export function useInvalidateFeedbackData(): (options?: InvalidateFeedbackDataOptions) => void {
  const queryClient = useQueryClient()
  return useCallback((options?: InvalidateFeedbackDataOptions) => {
    void invalidateFeedbackData(queryClient, options)
  }, [queryClient])
}
