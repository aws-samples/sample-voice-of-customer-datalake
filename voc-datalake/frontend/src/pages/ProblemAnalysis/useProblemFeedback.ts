/**
 * @fileoverview Server-aggregated problem tree for the Problem Analysis page.
 *
 * Problem Analysis is an aggregation view: every stat card and every level of
 * the category → subcategory → problem tree is derived from the WHOLE window of
 * feedback, not a page of it. It used to page `/feedback` client-side (capped at
 * ~2000 rows by MAX_AUTO_PAGES, and hard-walled at the server's 5000-row offset
 * ceiling), computing the tree in the browser — so a large corpus silently
 * truncated.
 *
 * Now the server does the O(rows) pass (`GET /feedback/problems`, up to a 50k
 * scan cap) and returns FINEST-GRAIN problem leaves — rows bucketed by exact
 * (category, subcategory, problem_summary) with each leaf's keyword set. This
 * hook merges those leaves to the similarity-slider threshold IN THE BROWSER,
 * over the few hundred distinct problems rather than the raw rows, so the slider
 * stays instant and the full window is covered. Individual feedback items are
 * fetched on demand when a problem is expanded (see ProblemRow drill-down).
 *
 * @module pages/ProblemAnalysis/useProblemFeedback
 */

import { useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { DateRangeParams } from '../../api/client'
import { EMPTY_FEEDBACK_FILTERS, filtersKey } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { getProblems } from '../../api/problemsApi'
import type { ProblemLeaf } from '../../api/problemsApi'
import { mergeLeaves } from './problemClustering'
import type { CategoryGroup, ProblemGroup, SubcategoryGroup } from './problemResolution'

/**
 * How long a loaded window counts as fresh — the window is an explicit control
 * (the time-range picker), so hold it settled rather than refetching on focus.
 */
export const WINDOW_STALE_MS = 5 * 60 * 1000

export interface ProblemTree {
  /** The full category→subcategory→problem tree, merged at `similarityThreshold`. */
  categories: CategoryGroup[]
  /** First load in flight — nothing to show yet. */
  isLoading: boolean
  /** Rows the server read into the aggregate (feedback_count). */
  loadedCount: number
  /** Same as loadedCount — the server reports exactly what it aggregated. */
  totalCount: number
  /** True when the window exceeded the server's scan cap, so counts undercount. */
  isPartial: boolean
  /** A request failed; with no data this means nothing was read. */
  isError: boolean
  /** The tree shown belongs to an earlier window/selection while the current one loads. */
  isUpdating: boolean
  /** Re-fetch the window. */
  retry: () => void
}

/**
 * Build the tree for one date window at one similarity threshold.
 *
 * The fetch is keyed on the window ONLY — the threshold is applied in the
 * `useMemo` merge, so moving the slider re-merges the already-fetched leaves
 * without a network round trip.
 */
export function useProblemFeedback(
  dateParams: DateRangeParams,
  apiEndpoint: string,
  similarityThreshold: number,
  filters: FeedbackFilterState = EMPTY_FEEDBACK_FILTERS,
): ProblemTree {
  const query = useQuery({
    // Keyed on window AND filters — both change the aggregated leaves (the
    // server applies every filter before bucketing). Threshold is NOT in the
    // key: it is applied in the merge below, so the slider re-merges the cached
    // leaves without a round trip.
    queryKey: ['feedback-problems', dateParams, filtersKey(filters)],
    queryFn: () => getProblems(dateParams, filters),
    enabled: !!apiEndpoint,
    staleTime: WINDOW_STALE_MS,
    refetchOnWindowFocus: false,
    // A filter change keeps the previous tree on screen (dimmed by the page)
    // until the new aggregate lands, instead of dropping back to "loading".
    placeholderData: keepPreviousData,
  })

  const leaves = query.data?.problems
  const categories = useMemo(
    () => buildTree(leaves ?? [], similarityThreshold),
    [leaves, similarityThreshold],
  )

  return {
    categories,
    isLoading: query.isLoading,
    loadedCount: query.data?.feedback_count ?? 0,
    totalCount: query.data?.feedback_count ?? 0,
    isPartial: query.data?.is_partial ?? false,
    isError: query.isError,
    isUpdating: query.isPlaceholderData,
    retry: () => void query.refetch(),
  }
}

/** Group leaves by category → subcategory, merge each bucket at the threshold. */
function buildTree(leaves: ProblemLeaf[], threshold: number): CategoryGroup[] {
  // category -> subcategory -> leaves
  const byCategory = new Map<string, Map<string, ProblemLeaf[]>>()
  for (const leaf of leaves) {
    const subMap = byCategory.get(leaf.category) ?? new Map<string, ProblemLeaf[]>()
    byCategory.set(leaf.category, subMap)
    const bucket = subMap.get(leaf.subcategory) ?? []
    bucket.push(leaf)
    subMap.set(leaf.subcategory, bucket)
  }

  const categories: CategoryGroup[] = []
  for (const [category, subMap] of byCategory) {
    const subcategories: SubcategoryGroup[] = []
    for (const [subcategory, bucket] of subMap) {
      const problems: ProblemGroup[] = mergeLeaves(bucket, threshold).map((merged) => ({
        problem: merged.problem,
        similarProblems: merged.similarProblems,
        rootCause: merged.rootCause,
        itemCount: merged.count,
        avgSentiment: merged.avgSentiment,
        urgentCount: merged.urgentCount,
      }))
      subcategories.push({
        subcategory,
        problems,
        totalItems: problems.reduce((sum, p) => sum + p.itemCount, 0),
        urgentCount: problems.reduce((sum, p) => sum + p.urgentCount, 0),
      })
    }
    subcategories.sort((a, b) => b.totalItems - a.totalItems)
    categories.push({
      category,
      subcategories,
      totalItems: subcategories.reduce((sum, s) => sum + s.totalItems, 0),
      urgentCount: subcategories.reduce((sum, s) => sum + s.urgentCount, 0),
    })
  }
  categories.sort((a, b) => b.totalItems - a.totalItems)
  return categories
}
