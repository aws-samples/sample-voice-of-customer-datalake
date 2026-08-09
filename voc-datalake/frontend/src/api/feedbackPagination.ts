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
 * Page size for `/feedback`, equal to the endpoint's `max_val`.
 *
 * Do not raise this to fetch more rows — the server clamps it back to 100 and
 * says nothing. Fetch another page with `nextPageOffset` instead.
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
  offset?: number
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
 * Guards against a zero-length page so a server that reports
 * `total > loaded` while returning nothing cannot spin the caller forever.
 */
export function nextPageOffset(lastPage: FeedbackPageCursor): number | undefined {
  const pageSize = lastPage.count ?? lastPage.items?.length ?? 0
  const loaded = (lastPage.offset ?? 0) + pageSize
  const total = lastPage.total ?? loaded
  return pageSize > 0 && loaded < total ? loaded : undefined
}
