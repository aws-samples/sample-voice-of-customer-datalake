/**
 * @fileoverview Lenient boundary for `POST /projects/{id}/feedback-preview`, the persona and
 * research wizards' live "N reviews match" line (ported from #429 by @aws-bryan).
 *
 * A malformed field degrades to "unknown" (`matched: null`) instead of throwing, so one bad
 * answer cannot blank the wizard step; the line then shows its error text.
 *
 * @module api/feedbackPreviewSchema
 */
import { z } from 'zod'

/** 'estimate' scales a random sample (well under a second); 'exact' reads every match. */
export type FeedbackPreviewMode = 'exact' | 'estimate'

/** Which wizard asks: only persona generation reports its sample limit. */
export type FeedbackPreviewPurpose = 'personas' | 'research'

const count = z.number().int().nonnegative()

const feedbackPreviewSchema = z.object({
  /** Reviews matching the filters; null when unknown (an estimate too thin to say, or a bad answer). */
  matched: count.nullable().catch(null),
  /** The exact read stopped at its time budget: there are at least `matched`. */
  matched_is_lower_bound: z.boolean().catch(false),
  /** How many of them persona generation reads; null for research or when not said. */
  sample_limit: count.nullable().catch(null),
  estimated: z.boolean().catch(false),
})

export type FeedbackPreview = z.infer<typeof feedbackPreviewSchema>

const UNKNOWN: FeedbackPreview = { matched: null, matched_is_lower_bound: false, sample_limit: null, estimated: false }

export function normalizeFeedbackPreview(raw: unknown): FeedbackPreview {
  const parsed = feedbackPreviewSchema.safeParse(raw)
  return parsed.success ? parsed.data : UNKNOWN
}
