/**
 * @fileoverview On-demand example rows for one expanded problem.
 *
 * Asks `/feedback` for the problem's category + subcategory under the page's
 * filters (so the examples match the aggregated tree), then narrows to the
 * merged group's problem texts — the server buckets by exact text, the client
 * merges similar ones, so only the client knows which texts form this group.
 * Reads one page: the drill-down is a sample for inspection; the true total is
 * the row's count badge.
 *
 * @module pages/ProblemAnalysis/useProblemItems
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams, FeedbackItem } from '../../api/client'
import { filtersKey, toFeedbackQueryParams } from '../../api/feedbackFilters'
import type { FeedbackFilterState } from '../../api/feedbackFilters'
import { FEEDBACK_PAGE_LIMIT } from '../../api/feedbackPagination'

export interface ProblemItems {
  items: FeedbackItem[]
  isLoading: boolean
  isError: boolean
}

export function useProblemItems(
  dateParams: DateRangeParams,
  category: string,
  subcategory: string,
  problemTexts: string[],
  filters: FeedbackFilterState,
  enabled: boolean,
): ProblemItems {
  const scoped: FeedbackFilterState = { ...filters, categories: [category], subcategories: [subcategory] }
  const query = useQuery({
    queryKey: ['problem-items', dateParams, filtersKey(scoped), problemTexts],
    queryFn: () =>
      api.getFeedback({ ...dateParams, limit: FEEDBACK_PAGE_LIMIT, ...toFeedbackQueryParams(scoped) }),
    enabled,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  const wanted = useMemo(() => new Set(problemTexts), [problemTexts])
  const items = useMemo(
    () => (query.data?.items ?? []).filter((item) => wanted.has(item.problem_summary ?? '')),
    [query.data, wanted],
  )
  return { items, isLoading: query.isLoading, isError: query.isError }
}
