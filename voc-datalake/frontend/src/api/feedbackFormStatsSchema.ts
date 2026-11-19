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
 * Each entry also carries the card's `headline` figure (null without a measuring question or an answer to it).
 *
 * The single-form read (`/feedback-forms/{id}/stats`) parses
 * its `stats` with the same schema: a malformed object reads as `null` (the
 * figures then show an em dash), never as an asserted shape.
 *
 * @module api/feedbackFormStatsSchema
 */
import { z } from 'zod'

/**
 * The card's headline figure (lambda/shared/forms_v2_results.py `headline`): the first measuring question's NPS
 * (points), CSAT (% satisfied) or average (rating, CES) with the answers it is over. Lenient: a malformed one reads
 * as null (the card shows no figure), never failing the stats it travels with.
 */
const HeadlineSchema = z.object({
  type: z.enum(['nps', 'csat', 'ces', 'rating']),
  value: z.number(),
  count: z.number().int().nonnegative(),
  scale_max: z.number().int().positive().optional().catch(undefined),
})

const FormStatsSchema = z.object({
  total_submissions: z.number().int().nonnegative(),
  avg_rating: z.number().nullable(),
  rating_count: z.number().int().nonnegative(),
  headline: HeadlineSchema.nullable().optional().catch(null),
  /** The latest counted response's time (`source_created_at`), when one carries it: "last response 2 h ago". */
  last_response_at: z.string().optional().catch(undefined),
  /** Per way the form was answered (the widget's `channel`), its latest response's time: the card's channel chips. */
  channels: z.object({
    link: z.string().optional().catch(undefined),
    iframe: z.string().optional().catch(undefined),
    script: z.string().optional().catch(undefined),
  }).optional().catch(undefined),
})

export type FormHeadline = z.infer<typeof HeadlineSchema>

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

