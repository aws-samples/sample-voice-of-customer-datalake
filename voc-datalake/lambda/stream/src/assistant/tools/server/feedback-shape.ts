/**
 * Feedback records → compact model-facing summaries and UI source cards.
 */
import { z } from 'zod';
import type { FeedbackSource } from '../../types.js';
import { isRecord, pick } from '../format.js';

/** Fields the model needs to reason about an item; storage keys never pass. */
const FEEDBACK_SUMMARY_FIELDS = [
  'feedback_id',
  'source_platform',
  'date',
  'source_created_at',
  'sentiment_label',
  'sentiment_score',
  'category',
  'subcategory',
  'urgency',
  'rating',
  'title',
  'problem_summary',
  'persona_name',
  'original_text',
] as const;

/** Storage/internal keys stripped from source cards. */
const SOURCE_EXCLUDED_KEY_PATTERN = /^(pk|sk|gsi\w*|ttl|raw_data|s3_raw_uri)$/;

/**
 * The only `category_override` fields a card may carry: the stored audit also
 * holds the editor's Cognito `by_sub`, which never reaches a client. Mirror of
 * `PUBLIC_OVERRIDE_FIELDS` in lambda/shared/category_override.py — this Lambda
 * reads the feedback table directly, so the API's sanitiser does not see these.
 */
const PUBLIC_OVERRIDE_FIELDS = ['previous_category', 'previous_subcategory', 'by_username', 'at'] as const;

/** `category_override` as a client may see it (no `by_sub`), or undefined when malformed. */
function publicCategoryOverride(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_OVERRIDE_FIELDS) {
    if (key in value) out[key] = value[key];
  }
  return out;
}

/** Upper bound on source cards one tool call contributes. */
const MAX_SOURCES_PER_CALL = 10;
const SOURCE_TEXT_MAX = 2000;

export function summarizeFeedback(record: Record<string, unknown>, textMax = 600): Record<string, unknown> {
  return pick(record, FEEDBACK_SUMMARY_FIELDS, textMax);
}

/** A source card for the SPA, or undefined when the record has no id. */
export function toFeedbackSource(record: Record<string, unknown>): FeedbackSource | undefined {
  const feedbackId = record.feedback_id;
  if (typeof feedbackId !== 'string' || feedbackId.length === 0) return undefined;
  const card: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SOURCE_EXCLUDED_KEY_PATTERN.test(key) || value === null || value === undefined) continue;
    if (key === 'category_override') {
      const override = publicCategoryOverride(value);
      if (override) card[key] = override;
      continue;
    }
    card[key] = typeof value === 'string' && value.length > SOURCE_TEXT_MAX ? value.slice(0, SOURCE_TEXT_MAX) : value;
  }
  return { ...card, feedback_id: feedbackId };
}

export function toFeedbackSources(records: readonly Record<string, unknown>[]): FeedbackSource[] {
  const sources: FeedbackSource[] = [];
  for (const record of records) {
    const source = toFeedbackSource(record);
    if (source) sources.push(source);
    if (sources.length >= MAX_SOURCES_PER_CALL) break;
  }
  return sources;
}

const itemListSchema = z.array(z.unknown()).catch([]);

/** The record entries of `body[key]` (lenient: non-records are dropped). */
export function recordsAt(body: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(body)) return [];
  return itemListSchema.parse(body[key]).filter(isRecord);
}
