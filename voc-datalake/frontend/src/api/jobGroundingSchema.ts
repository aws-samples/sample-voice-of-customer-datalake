/**
 * @fileoverview Runtime validation for how much feedback a job's result used.
 *
 * `generate_personas` reports what its output is grounded in — how many records
 * reached the model, how many were read, and whether either cap bound (issue
 * #231). The values arrive inside a job record read straight out of DynamoDB, so
 * the declared TypeScript types are a claim about the wire, not a fact about it:
 * a field persisted as a DynamoDB String round-trips as `"145"` rather than
 * `145`. `api/feedbackSchema.ts` exists for exactly that reason on the feedback
 * endpoints, and `ProjectJob` has no schema at all — it is fetched through a
 * bare `fetchApi<ProjectJob>`.
 *
 * Rather than validate the whole of `ProjectJob` (which no consumer does today
 * and which would be a much larger change than #231 warrants), this normalizes
 * the one block whose numbers get rendered. Lenient throughout: a malformed
 * value degrades to "unknown" so the notice falls back to its count-free
 * wording, because a result that was genuinely truncated must still say so even
 * when the numbers describing it are unusable.
 *
 * @module api/jobGroundingSchema
 */
import { z } from 'zod'

/**
 * A non-negative integer from a number, or from a string holding one.
 *
 * The accepted input types are narrowed before any coercion, because `Number`
 * is far more permissive than it looks: `Number(true)` is `1` and
 * `Number(' ')` is `0`, so a boolean or a blank string would otherwise pass as a
 * perfectly plausible count and render as one.
 */
const wireCount = z.preprocess((value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  // Whitespace-only needs rejecting explicitly, not just the empty string:
  // Number(' ') and Number('\t') are both 0.
  if (typeof value === 'string' && value.trim() === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  // Reject NaN, Infinity, negatives, and fractions: every one of these would
  // render as a count, and a count is what the user reads it as.
  return Number.isInteger(n) && n >= 0 ? n : undefined
}, z.number().optional())

/**
 * Only a literal `true` counts as truncated.
 *
 * A string `"false"` is truthy in JavaScript, and coercing it would announce a
 * loss that did not happen on every completed job.
 *
 * Note the deliberate asymmetry: this collapses `false` and absent into the same
 * `undefined`, so a consumer cannot tell "the backend reported no truncation"
 * from "an older job record predating this field". That is right for a warning,
 * which should stay silent in both cases. Anything that later wants to show
 * positive confirmation — "grounded in all N items" — needs a three-state read
 * (`true` / `false` / absent) rather than this one, because on an old record it
 * would otherwise confirm something nothing ever measured.
 */
const wireFlag = z.preprocess(
  (value) => (value === true ? true : undefined),
  z.literal(true).optional(),
)

export const JobGroundingSchema = z.object({
  feedback_count: wireCount,
  feedback_items_used: wireCount,
  context_truncated: wireFlag,
  fetch_limit_reached: wireFlag,
  fetch_limit: wireCount,
})

export type JobGrounding = z.infer<typeof JobGroundingSchema>

/** Every field absent — what an unparseable or missing metadata block yields. */
const NOTHING_REPORTED: JobGrounding = {
  feedback_count: undefined,
  feedback_items_used: undefined,
  context_truncated: undefined,
  fetch_limit_reached: undefined,
  fetch_limit: undefined,
}

/**
 * Normalize a job result's `metadata` block.
 *
 * Never throws and never returns null: a caller rendering a notice should not
 * have to branch on "the wire was malformed" separately from "the field was
 * absent", since it treats both the same way.
 */
export function parseJobGrounding(raw: unknown): JobGrounding {
  const parsed = JobGroundingSchema.safeParse(raw)
  return parsed.success ? parsed.data : NOTHING_REPORTED
}

/**
 * True when the reported counts can be shown to a user.
 *
 * Both numbers are needed for the "N of M" wording, and M < N would be
 * incoherent — it would tell the user more records reached the model than were
 * read. Either case falls back to the count-free message.
 */
export function hasUsableCounts(
  grounding: JobGrounding,
): grounding is JobGrounding & { feedback_items_used: number, feedback_count: number } {
  const { feedback_items_used: used, feedback_count: total } = grounding
  return used !== undefined && total !== undefined && used <= total
}
