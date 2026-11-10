/**
 * @fileoverview Wire boundary for the per-form stats map of
 * `GET /feedback-forms?include=stats` (E2E F11).
 *
 * The Feedback Forms page used to ask `/feedback-forms/{id}/stats` once per
 * card; the list now carries every card's stats in one `stats` map keyed by
 * form id, each value the single-form route's `stats` object. Validated here,
 * leniently: an entry that does not match is dropped (that card then asks for
 * its own stats, as before), and a missing or malformed map is `null` — which is
 * also what an older API or a failed stats read (`stats_error`) produces.
 *
 * The single-form reads (`/feedback-forms/{id}/stats` and `/submissions`) parse
 * their `stats` with the same schema: a malformed object reads as `null` (the
 * figures then show an em dash), never as an asserted shape.
 *
 * @module api/feedbackFormStatsSchema
 */
import { z } from 'zod'
import { lenientText, parsedList } from './schemaList'

const FormStatsSchema = z.object({
  total_submissions: z.number().int().nonnegative(),
  avg_rating: z.number().nullable(),
  rating_count: z.number().int().nonnegative(),
})

export type FormStats = z.infer<typeof FormStatsSchema>

/** The valid entries of a raw `stats` map, or null when there is no map at all. */
export function normalizeFormStatsMap(raw: unknown): Record<string, FormStats> | null {
  const map = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!map.success) return null
  return Object.fromEntries(
    Object.entries(map.data).flatMap(([formId, value]) => {
      const parsed = FormStatsSchema.safeParse(value)
      return parsed.success ? [[formId, parsed.data] as const] : []
    }),
  )
}

/** `stats` of a single-form read: the parsed object, or null when it is missing or malformed. */
function parsedStats(raw: unknown): FormStats | null {
  const parsed = FormStatsSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** `GET /feedback-forms/{id}/stats`, validated. */
export interface FormStatsResponse {
  readonly stats: FormStats | null
}

export function parseFormStatsResponse(raw: unknown): FormStatsResponse {
  const body = z.object({ stats: z.unknown() }).safeParse(raw)
  return { stats: body.success ? parsedStats(body.data.stats) : null }
}

const SubmissionSchema = z.object({
  feedback_id: z.string().min(1),
  original_text: lenientText,
  rating: z.number().nullable().catch(null),
  sentiment_label: lenientText,
  category: lenientText,
  created_at: lenientText,
  persona_name: lenientText,
})

type FormSubmission = z.infer<typeof SubmissionSchema>

/** `GET /feedback-forms/{id}/submissions`, validated: a malformed row costs only itself. */
export interface FormSubmissionsResponse {
  readonly stats: FormStats | null
  readonly submissions: readonly FormSubmission[]
}

const submissionList = parsedList(SubmissionSchema)

export function parseFormSubmissionsResponse(raw: unknown): FormSubmissionsResponse {
  const body = z.object({ stats: z.unknown(), submissions: z.unknown() }).partial().safeParse(raw)
  const data = body.success ? body.data : {}
  return { stats: parsedStats(data.stats), submissions: submissionList.parse(data.submissions) }
}
