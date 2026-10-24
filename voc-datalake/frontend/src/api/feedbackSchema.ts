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
import { toOptionalFiniteNumber } from './lenientFields'
import { StringMapSchema, TagsSchema } from './dimensionsSchema'
import type { FeedbackItem } from './types'

/** Coerce an unknown value to a finite number, or `0` when not numeric. */
function toFiniteNumberOrZero(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

// Required string fields degrade to '' rather than rejecting the whole item:
// the previous (no-op) parser never threw, so normalization must not regress a
// currently-rendering response into a hard failure.
const lenientString = z.string().catch('')

const optionalText = z.string().optional().catch(undefined)

/**
 * Who changed a category by hand, and from what. Lenient on purpose: a badge
 * with no author still beats a crashed card. `by_sub` is deliberately not read —
 * the UI names people by username, never by Cognito subject.
 */
export const CategoryOverrideSchema = z.object({
  previous_category: z.string().catch(''),
  previous_subcategory: optionalText,
  by_username: optionalText,
  at: optionalText,
})

export type CategoryOverride = z.infer<typeof CategoryOverrideSchema>

/**
 * Schema for a single feedback item.
 *
 * - Numeric fields are coerced from possible string representations.
 * - Unknown keys (DynamoDB GSI/internal attributes the frontend never reads)
 *   are stripped, so the parsed object matches the `FeedbackItem` contract.
 */
const FeedbackItemSchema = z.object({
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
  category_source: z.string().optional().catch(undefined),
  category_override: CategoryOverrideSchema.optional().catch(undefined),
  author: optionalText,
  title: optionalText,
  // Absent, junk or empty maps / lists read as absent: most items carry none.
  dimensions: StringMapSchema.transform(emptyAsUndefined),
  dimension_sources: StringMapSchema.transform(emptyAsUndefined),
  tags: TagsSchema.transform((tags) => (tags.length === 0 ? undefined : tags)),
  // An unknown policy reads as absent (= allow): only a recognised one earns a badge.
  pii_policy: z.enum(['allow', 'redact', 'summary_only']).optional().catch(undefined),
})

function emptyAsUndefined(map: Record<string, string>): Record<string, string> | undefined {
  return Object.keys(map).length === 0 ? undefined : map
}

/** Normalize a single raw feedback item, coercing numeric fields. */
export function normalizeFeedbackItem(raw: unknown): FeedbackItem {
  return FeedbackItemSchema.parse(raw)
}

/** Normalize a list of raw feedback items, coercing numeric fields. */
export function normalizeFeedbackItems(items: readonly unknown[]): FeedbackItem[] {
  return items.map((item) => FeedbackItemSchema.parse(item))
}
