/**
 * @fileoverview Shared offset pagination for the `/feedback` list endpoint.
 *
 * `/feedback` bounds `limit` server-side with
 * `validate_limit(..., default=50, max_val=100)`, and `validate_int` **clamps
 * rather than rejecting** — an over-sized `limit` comes back silently reduced,
 * with only the echoed `limit` in the response to give it away. That is exactly
 * how Problem Analysis ended up computing a whole problem hierarchy from 100
 * rows while asking for 500 (U5b).
 *
 * So the page size lives here as one exported constant: callers spend
 * `FEEDBACK_PAGE_LIMIT` instead of a literal, and getting more than one page
 * is a pagination question, never a bigger-`limit` question.
 *
 * @module api/feedbackPagination
 */

import type { FeedbackItem } from './client'

/**
 * Page size for `/feedback`, equal to the endpoint's server-side maximum.
 *
 * Mirrors `max_val` in `lambda/api/metrics_handler.py` → `list_feedback`:
 * `validate_limit(params.get('limit'), default=50, max_val=100)`, bounded by
 * `validate_limit` / `validate_int` in `lambda/shared/api.py`.
 *
 * Do not raise this to fetch more rows — the server clamps it back and says
 * nothing. Fetch another page with {@link nextPageOffset} instead.
 *
 * The two sides are kept in step by
 * `lambda/api/test/test_feedback_page_limit_lockstep.py`, which reads this
 * constant out of this file, so a `max_val` change fails a test rather than
 * silently shrinking every paged read.
 */
export const FEEDBACK_PAGE_LIMIT = 100

/**
 * The cursor fields {@link nextPageOffset} reads.
 *
 * Deliberately not coupled to `FeedbackItem`: advancing a cursor depends on
 * *how many* rows came back, never on what is in them.
 *
 * - `count` is this page's length (0..limit), **not** a window total.
 * - `total` is the filtered candidate-window size.
 */
export interface FeedbackPageCursor {
  count?: number
  items?: readonly unknown[]
  total?: number
}

/**
 * A `/feedback` response page.
 *
 * `is_partial_window` means the server truncated the candidate window, so even
 * `total` is a lower bound and any count derived from it undercounts.
 */
export interface FeedbackPage extends FeedbackPageCursor {
  items?: FeedbackItem[]
  is_partial_window?: boolean
}

/** Rows in one page, however the response chose to report them. */
function pageLength(page: FeedbackPageCursor): number {
  return page.count ?? page.items?.length ?? 0
}

/**
 * Offset of the next `/feedback` page, or `undefined` once the loaded rows
 * cover the (windowed) total.
 *
 * `loaded < total` is the correct signal, **not** `count < limit`: a full page
 * can still be the last one, and a short page can precede more. Without a
 * post-query filter the server sizes its candidate window from `offset+limit`,
 * so `total` is a lower bound that grows as pages are read — this still
 * converges, because the bound stops growing once it exceeds the real total.
 *
 * `loaded` is summed from the pages actually held, **not** taken from the
 * response's echoed `offset`. Trusting the echo means a response that omits it
 * collapses `loaded` to one page length and hands back the same offset forever
 * — an endless walk over duplicate rows, capped only by the caller's own page
 * budget, and not capped at all where paging is user-driven.
 *
 * Also refuses a zero-length page, so a server reporting `total > loaded` while
 * returning nothing cannot spin the caller.
 *
 * ⚠️ Because `loaded` is the sum over `allPages`, this is **incompatible with
 * TanStack's `maxPages`**: evicting a page shrinks that sum, rewinding the
 * offset and re-fetching rows already seen, indefinitely. Keep every page, or
 * track the offset outside the cache.
 */
export function nextPageOffset(
  lastPage: FeedbackPageCursor,
  allPages: readonly FeedbackPageCursor[]
): number | undefined {
  if (pageLength(lastPage) === 0) return undefined
  const loaded = allPages.reduce((sum, page) => sum + pageLength(page), 0)
  const total = lastPage.total ?? loaded
  return loaded < total ? loaded : undefined
}
