/**
 * @fileoverview Runtime validation/normalization for feedback API responses.
 *
 * The `/feedback*` endpoints return DynamoDB items where numeric fields
 * (`sentiment_score`, `rating`) may arrive as JSON **strings** — records
 * persisted as DynamoDB String attributes round-trip as `"0.9"` rather than
 * `0.9`. The `FeedbackItem` TypeScript type declares these as `number`, so any
 * consumer that trusts the type (e.g. `sentiment_score.toFixed()` in the PDF
 * export) crashes at runtime.
 *
 * This module coerces those fields once, at the API boundary, so the rest of
 * the app can rely on the declared `number` contract. It follows the
 * project-wide convention of using Zod for runtime validation instead of
 * trusting raw JSON via type assertions.
 *
 * @module api/feedbackSchema
 */

import { z } from 'zod'
import type { FeedbackItem } from './types'

/** Coerce an unknown value to a finite number, or `0` when not numeric. */
function toFiniteNumberOrZero(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Coerce an unknown value to a finite number, or `undefined` when absent/invalid. */
function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

// Required string fields degrade to '' rather than rejecting the whole item:
// the previous (no-op) parser never threw, so normalization must not regress a
// currently-rendering response into a hard failure.
const lenientString = z.string().catch('')

/**
 * Schema for a single feedback item.
 *
 * - Numeric fields are coerced from possible string representations.
 * - Unknown keys (DynamoDB GSI/internal attributes the frontend never reads)
 *   are stripped, so the parsed object matches the `FeedbackItem` contract.
 */
export const FeedbackItemSchema = z.object({
  feedback_id: lenientString,
  source_id: lenientString,
  source_platform: lenientString,
  source_channel: lenientString,
  ingestion_method: z.string().optional(),
  source_url: z.string().optional(),
  brand_name: lenientString,
  source_created_at: lenientString,
  processed_at: lenientString,
  original_text: lenientString,
  original_language: lenientString,
  normalized_text: z.string().optional(),
  rating: z.preprocess(toOptionalFiniteNumber, z.number().optional()),
  category: lenientString,
  subcategory: z.string().optional(),
  journey_stage: lenientString,
  sentiment_label: lenientString,
  sentiment_score: z.preprocess(toFiniteNumberOrZero, z.number()),
  urgency: lenientString,
  impact_area: lenientString,
  problem_summary: z.string().optional(),
  problem_root_cause_hypothesis: z.string().optional(),
  direct_customer_quote: z.string().optional(),
  persona_name: z.string().optional(),
  persona_type: z.string().optional(),
})

/** Normalize a single raw feedback item, coercing numeric fields. */
export function normalizeFeedbackItem(raw: unknown): FeedbackItem {
  return FeedbackItemSchema.parse(raw)
}

/** Normalize a list of raw feedback items, coercing numeric fields. */
export function normalizeFeedbackItems(items: readonly unknown[]): FeedbackItem[] {
  return items.map((item) => FeedbackItemSchema.parse(item))
}
