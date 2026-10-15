/**
 * @fileoverview Query keys for feedback-form data read from more than one feature.
 *
 * Both keys here crossed the "second feature reads it" line when the
 * prioritization row started showing a linked form's collected ratings, and each
 * drifts silently rather than loudly:
 *
 * - `['feedback-forms']` — the Feedback Forms page owns the list and invalidates
 *   it on create, update and delete. Prioritization reads the same list to learn
 *   which form validates which document. Spelled as a literal in both places, a
 *   rename gives the second reader its own cache entry that no mutation ever
 *   invalidates, so it serves a stale list until the page is reloaded.
 * - `['form-stats', id]` — read by the form card and by the evidence panel on an
 *   expanded prioritization row. Sharing it is the entire cost argument for that
 *   panel: `GET /feedback-forms/{id}/stats` scans a brand-wide feedback partition
 *   with a filter expression, so a row opened after visiting the Feedback Forms
 *   page must reuse the cached payload rather than pay for it twice. If the two
 *   spellings drift, nothing breaks and nothing fails — it just quietly costs
 *   double.
 *
 * `FORM_STATS_STALE_TIME_MS` lives here for the same reason: matching keys buy
 * nothing if one side considers the entry stale on arrival.
 *
 * Same rule as `projectQueryKeys`: a query key stays private to its page until a
 * second feature reads it, and moves here when one does. No imports, so importing
 * it drags no data layer into another chunk.
 *
 * @module api/feedbackFormQueryKeys
 */

/** The feedback-form list — `api.getFeedbackForms`. */
export const feedbackFormsKey = () => ['feedback-forms'] as const

/** One form's submission count and average rating — `api.getFeedbackFormStats`. */
export const formStatsKey = (formId: string) => ['form-stats', formId] as const

/**
 * How long a stats payload stays fresh.
 *
 * Shared rather than repeated at each `useQuery`: the point of sharing the key is
 * that the second reader does not re-fetch, and a shorter window on either side
 * would defeat that without failing anything.
 */
export const FORM_STATS_STALE_TIME_MS = 30000
