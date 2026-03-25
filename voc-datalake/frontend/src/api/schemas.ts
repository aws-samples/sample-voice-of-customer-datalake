/**
 * Zod schemas for runtime validation of critical API responses.
 *
 * Only the most important response shapes are validated here (MetricsSummary,
 * FeedbackItem). Less critical endpoints use the passthrough `parseJsonResponse`
 * which trusts the server ("trust the server" pattern).
 */
import { z } from 'zod'

// ── MetricsSummary ──────────────────────────────────────────────────────────

/**
 * DynamoDB Decimal values are serialized as strings by Lambda Powertools.
 * Use z.coerce.number() for all numeric fields from DynamoDB.
 */
const DailyTotalSchema = z.object({
  date: z.string(),
  count: z.coerce.number(),
})

const DailySentimentSchema = z.object({
  date: z.string(),
  avg_sentiment: z.coerce.number(),
  count: z.coerce.number(),
})

export const MetricsSummarySchema = z.object({
  period_days: z.coerce.number(),
  total_feedback: z.coerce.number(),
  avg_sentiment: z.coerce.number(),
  urgent_count: z.coerce.number(),
  daily_totals: z.array(DailyTotalSchema),
  daily_sentiment: z.array(DailySentimentSchema),
})

// ── FeedbackItem ────────────────────────────────────────────────────────────

/**
 * DynamoDB stores numbers as Decimal, and the Lambda Powertools JSON encoder
 * serializes Decimal values as strings (e.g. "0.750" instead of 0.75).
 * We use z.coerce.number() for numeric fields so that string-encoded
 * decimals are correctly parsed into numbers on the frontend.
 */
export const FeedbackItemSchema = z.object({
  feedback_id: z.string(),
  source_id: z.string().default(''),
  source_platform: z.string(),
  source_channel: z.string().default('unknown'),
  source_url: z.string().optional(),
  brand_name: z.string().default(''),
  source_created_at: z.string().default(''),
  processed_at: z.string().default(''),
  original_text: z.string().default(''),
  original_language: z.string().default('unknown'),
  normalized_text: z.string().optional(),
  rating: z.coerce.number().optional(),
  category: z.string().default('other'),
  subcategory: z.string().optional(),
  journey_stage: z.string().default('unknown'),
  sentiment_label: z.string().default('neutral'),
  sentiment_score: z.coerce.number().default(0),
  urgency: z.string().default('low'),
  impact_area: z.string().default('other'),
  problem_summary: z.string().optional(),
  problem_root_cause_hypothesis: z.string().optional(),
  direct_customer_quote: z.string().optional(),
  persona_name: z.string().optional(),
  persona_type: z.string().optional(),
})
