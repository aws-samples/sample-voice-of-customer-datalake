/**
 * @fileoverview Windowed feedback for the Problem Analysis page.
 *
 * Problem Analysis is an aggregation view: every stat card and every level of
 * the category → subcategory → problem tree is derived from the *whole* set of
 * feedback in the window, not from a page of it. It used to ask `/feedback` for
 * `limit: 500` in a single request — but that endpoint clamps `limit` to 100
 * without complaining, so the entire page was computed from the first 100 rows
 * and presented as if complete (U5b).
 *
 * Asking for a bigger `limit` cannot fix that; the cap is server-side. So this
 * hook pages through the window instead, advancing automatically rather than
 * behind a "Load more" button, because the totals are wrong until the window is
 * read. Results render progressively as pages land, so the page stays usable
 * while it fills.
 *
 * Two independent stops keep that from running away: `nextPageOffset` refuses a
 * zero-length page, and `MAX_AUTO_PAGES` bounds the walk outright. When either
 * stop (or the server's own `is_partial_window`) leaves rows unread, `isPartial`
 * says so, so a truncated view is visibly truncated instead of silently wrong.
 *
 * The real cure is server-side aggregation, so one request answers "how many
 * problems per category" without shipping every row to the browser. That is
 * U5a's territory; this hook makes the current design honest.
 *
 * @module pages/ProblemAnalysis/useProblemFeedback
 */

import { useEffect, useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import type { DateRangeParams, FeedbackItem } from '../../api/client'
import { FEEDBACK_PAGE_LIMIT, nextPageOffset } from '../../api/feedbackPagination'
import type { FeedbackPage } from '../../api/feedbackPagination'

/**
 * Ceiling on pages fetched automatically — 20 pages of
 * {@link FEEDBACK_PAGE_LIMIT} rows.
 *
 * A bound is required, not defensive: `/feedback` will paginate to
 * `MAX_FEEDBACK_OFFSET` (5000) rows, and walking that on mount would be 50
 * sequential requests. Past this point the view reports itself partial rather
 * than keeping the user waiting.
 */
export const MAX_AUTO_PAGES = 20

/**
 * How long a loaded window counts as fresh — longer than the app-wide 30s
 * default because re-walking costs one request per 100 rows.
 */
export const WINDOW_STALE_MS = 5 * 60 * 1000

export interface ProblemFeedback {
  /** Every row loaded so far, across pages. */
  items: FeedbackItem[]
  /** First page in flight — nothing to show yet. */
  isLoading: boolean
  /** A later page is in flight; `items` is usable but still growing. */
  isLoadingMore: boolean
  loadedCount: number
  /** Candidate-window size. A lower bound while pages are still being read. */
  totalCount: number
  /** True when rows in the window were left unread, so counts undercount. */
  isPartial: boolean
  /**
   * A request failed. With `items` empty this means **nothing** was read, which
   * must not be rendered as a window that legitimately contains nothing —
   * callers show an error rather than zeroed aggregates.
   */
  isError: boolean
  /** Re-reads the window from the first page. */
  retry: () => void
}

export function useProblemFeedback(
  dateParams: DateRangeParams,
  apiEndpoint: string
): ProblemFeedback {
  const query = useInfiniteQuery({
    queryKey: ['feedback-problems', dateParams],
    queryFn: ({ pageParam }) =>
      api.getFeedback({ ...dateParams, limit: FEEDBACK_PAGE_LIMIT, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: nextPageOffset,
    enabled: !!apiEndpoint,
    // A walk is one request per 100 rows, and TanStack refetches EVERY page of
    // an infinite query — so the app-wide 30s `staleTime` plus the default
    // refetch-on-focus would re-issue the whole walk each time the tab regains
    // focus. Hold the window settled instead; the time range is an explicit
    // control, so the user says when to look again.
    staleTime: WINDOW_STALE_MS,
    refetchOnWindowFocus: false,
    // Deliberately NOT `maxPages`: it evicts pages from the cache, and every
    // count on this screen is an aggregate over all of them.
  })

  const { data, hasNextPage, isFetchingNextPage, isError, fetchNextPage, refetch } = query
  const pageCount = data?.pages.length ?? 0
  const budgetSpent = pageCount >= MAX_AUTO_PAGES

  // `isError` is load-bearing: without it a persistently failing page would
  // settle with `hasNextPage` still true, re-arming this effect forever.
  const shouldAdvance = hasNextPage && !budgetSpent && !isError

  // `pageCount` is the ratchet, not an incidental dependency. Once a page
  // settles, `shouldAdvance` is true and `isFetchingNextPage` is false again —
  // exactly the values they held when the previous page settled — so without a
  // per-page dependency the array is unchanged, the effect never re-runs, and
  // the walk stalls after a single extra page. Pinned by "pages until every row
  // in the window is loaded".
  useEffect(() => {
    if (shouldAdvance && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [shouldAdvance, isFetchingNextPage, pageCount, fetchNextPage])

  // Keyed on `data` rather than a derived array: TanStack keeps `data` stable
  // between settles, so this recomputes per page rather than per render.
  const items = useMemo(() => collectItems(data?.pages), [data])

  // The walk stopped early with rows still unread: the budget ran out, or a
  // page failed. A failed page has to count here too — otherwise a mid-walk
  // error reproduces the very defect this hook exists to fix, presenting short
  // counts as complete ones.
  const stoppedEarly = hasNextPage && (budgetSpent || isError)

  return {
    items,
    isLoading: query.isLoading,
    isLoadingMore: isFetchingNextPage,
    loadedCount: items.length,
    isError,
    retry: () => {
      void refetch()
    },
    ...summarizeCoverage(data?.pages, items.length, stoppedEarly),
  }
}

/** Every row loaded so far, flattened across pages. */
function collectItems(pages: readonly FeedbackPage[] | undefined): FeedbackItem[] {
  return (pages ?? []).flatMap((page) => page.items ?? [])
}

/**
 * How much of the window the loaded rows actually cover.
 *
 * `totalCount` floors at `loadedCount` because without a post-query filter the
 * server sizes its candidate window from `offset+limit`, so its `total` is a
 * lower bound that can trail the rows already in hand.
 */
function summarizeCoverage(
  pages: readonly FeedbackPage[] | undefined,
  loadedCount: number,
  stoppedEarly: boolean
): { totalCount: number; isPartial: boolean } {
  const lastPage = pages?.at(-1)
  return {
    totalCount: Math.max(lastPage?.total ?? loadedCount, loadedCount),
    isPartial: stoppedEarly || (lastPage?.is_partial_window ?? false),
  }
}
