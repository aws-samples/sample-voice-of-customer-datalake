/**
 * @fileoverview Lenient wire schemas of the feedback boards as their own evidence source
 * (docs/feature-requests.md): a request's light enrichment, the Insights answer
 * (`GET /feature-requests/insights`) and the enrich answer (`POST /feature-requests/insights/enrich`).
 *
 * Board requests never enter the review pipeline: these figures are read and shown apart from every
 * review metric. Each part falls back on its own, so one malformed row costs exactly itself and an
 * unreadable answer reads as empty instead of blanking the page.
 *
 * @module api/featureRequestInsightsSchema
 */
import { z } from 'zod'
import { count } from './featureBoardsSchema'
import { lenientText, parsedList } from './schemaList'

export const ENRICHMENT_SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const
export type EnrichmentSentiment = typeof ENRICHMENT_SENTIMENTS[number]

const sentimentSchema = z.enum(ENRICHMENT_SENTIMENTS).nullable().optional().catch(null).transform((value) => value ?? null)
const nullableText = z.string().min(1).nullable().optional().catch(null).transform((value) => value ?? null)

/**
 * A request's enrichment (`FR#{id}` / `META` → `enrichment`): absent = not enriched yet, so an
 * unreadable value reads as absent too. Only what the board UI shows is kept.
 */
export const enrichmentSchema = z.object({
  status: z.enum(['ok', 'failed']).catch('failed'),
  category: nullableText,
  subcategory: nullableText,
  sentiment: sentimentSchema,
  problem_summary: nullableText,
  enriched_at: lenientText,
}).optional().catch(undefined)
export type RequestEnrichment = NonNullable<z.infer<typeof enrichmentSchema>>

const topRequestSchema = z.object({
  request_id: z.string().min(1),
  board_id: lenientText,
  title: lenientText,
  status: lenientText,
  supporters: count,
  category: nullableText,
})
export type InsightTopRequest = z.infer<typeof topRequestSchema>

const categoryRowSchema = z.object({
  /** null and 'uncategorized' both mean "no category". */
  category: nullableText.transform((value) => (value === 'uncategorized' ? null : value)),
  requests: count,
  supporters: count,
})

const statusRowSchema = z.object({ status: z.string().min(1), requests: count, supporters: count })

const sentimentRowSchema = z.object({ sentiment: sentimentSchema, requests: count })

const totalsSchema = z.object({ requests: count, supporters: count, enriched: count })
  .catch({ requests: 0, supporters: 0, enriched: 0 })

const insightsSchema = z.object({
  board: z.object({ id: z.string().min(1), label: lenientText }).nullable().optional().catch(null)
    .transform((value) => value ?? null),
  window_days: count,
  totals: totalsSchema,
  top: parsedList(topRequestSchema),
  by_category: parsedList(categoryRowSchema),
  by_status: parsedList(statusRowSchema),
  by_sentiment: parsedList(sentimentRowSchema),
})
export type FeatureRequestInsights = z.infer<typeof insightsSchema>

/** Any answer as an object (a non-object reads as `{}`), so every field's own fallback applies. */
const answerObject = z.record(z.string(), z.unknown()).catch({})

/** Never throws: every field above falls back on its own. */
export function normalizeInsights(raw: unknown): FeatureRequestInsights {
  return insightsSchema.parse(answerObject.parse(raw))
}

const enrichResultSchema = z.object({ queued: count, remaining: count })
export type EnrichResult = z.infer<typeof enrichResultSchema>

export function normalizeEnrichResult(raw: unknown): EnrichResult {
  const parsed = enrichResultSchema.safeParse(raw)
  return parsed.success ? parsed.data : { queued: 0, remaining: 0 }
}
