/**
 * `/metrics/overview`: every Dashboard/Categories breakdown for ONE filtered
 * window, from a single server-side scan.
 *
 * Aggregates can't answer "negative, high-usefulness feedback from these two
 * sources", so pages call this only while filters are active and keep the exact
 * aggregate endpoints otherwise. The response reuses the existing breakdown
 * shapes so charts don't care which path produced them.
 *
 * Own module because `client.ts` sits at its max-lines budget.
 */
import { z } from 'zod'
import { fetchApi } from './client'
import type { DateRangeParams } from './client'
import { filteredSearchParams } from './feedbackFilters'
import type { FeedbackFilterState } from './feedbackFilters'
import type { CategoryBreakdown, MetricsSummary, SentimentBreakdown, SourceBreakdown } from './types'

export interface MetricsOverview {
  period_days: number
  feedback_count: number
  is_partial: boolean
  summary: MetricsSummary
  sentiment: SentimentBreakdown
  categories: CategoryBreakdown
  sources: SourceBreakdown
  personas: Record<string, number>
  issues: Record<string, number>
  /** Registry field → value (incl. `unscored`) → count. */
  enrichment: Record<string, Record<string, number>>
}

const count = z.coerce.number().catch(0)
const counts = z.record(z.string(), count).catch({})

const summarySchema = z.object({
  period_days: count,
  total_feedback: count,
  avg_sentiment: count,
  urgent_count: count,
  is_partial: z.boolean().catch(false),
  daily_totals: z.array(z.object({ date: z.string().catch(''), count })).catch([]),
  daily_sentiment: z.array(z.object({ date: z.string().catch(''), avg_sentiment: count, count })).catch([]),
})

const responseSchema = z.object({
  period_days: count,
  feedback_count: count,
  is_partial: z.boolean().catch(false),
  summary: summarySchema.catch({
    period_days: 0, total_feedback: 0, avg_sentiment: 0, urgent_count: 0, is_partial: false,
    daily_totals: [], daily_sentiment: [],
  }),
  sentiment: z.object({
    total: count,
    breakdown: counts,
    percentages: counts,
  }).catch({ total: 0, breakdown: {}, percentages: {} }),
  categories: counts,
  sources: counts,
  personas: counts,
  issues: counts,
  enrichment: z.record(z.string(), counts).catch({}),
})

/** Normalize a raw `/metrics/overview` payload (exported for tests). Never throws. */
export function normalizeMetricsOverview(raw: unknown): MetricsOverview {
  const attempt = responseSchema.safeParse(raw)
  // A non-object body degrades to an empty overview, like every other field.
  const parsed = attempt.success ? attempt.data : responseSchema.parse({})
  const { period_days: periodDays, is_partial: isPartial } = parsed
  return {
    period_days: periodDays,
    feedback_count: parsed.feedback_count,
    is_partial: isPartial,
    summary: parsed.summary,
    sentiment: { period_days: periodDays, is_partial: isPartial, ...parsed.sentiment },
    categories: { period_days: periodDays, is_partial: isPartial, categories: parsed.categories },
    sources: { period_days: periodDays, is_partial: isPartial, sources: parsed.sources },
    personas: parsed.personas,
    issues: parsed.issues,
    enrichment: parsed.enrichment,
  }
}

export async function getMetricsOverview(
  dateParams: DateRangeParams,
  filters: FeedbackFilterState,
): Promise<MetricsOverview> {
  const search = filteredSearchParams({ ...dateParams }, filters)
  return normalizeMetricsOverview(await fetchApi<unknown>(`/metrics/overview?${search.toString()}`))
}
