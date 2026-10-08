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
 * @module api/feedbackFormStatsSchema
 */
import { z } from 'zod'

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
