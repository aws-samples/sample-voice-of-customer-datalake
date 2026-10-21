/**
 * The structured feedback filters the chat request carries, and the predicate
 * that applies them to a feedback row.
 *
 * This is the stream Lambda's copy of the one filter model the rest of the app
 * shares — `lambda/shared/feedback_filters.py` (the REST routes) and
 * `frontend/src/api/feedbackFilters.ts` (the pages). The chat page sends the
 * SAME wire shape those produce, so the reviews the model reasons over are
 * scoped exactly the way the Dashboard/Categories pages scope their views.
 *
 * Only the dimensions the chat tool can act on are modelled here: the plain
 * multi-value lists plus urgency and the enrichment `usefulness` field.
 * Custom-field (`cf_*`) scoping is a REST-only concern (the count query honours
 * it); the tool scan does not read custom_fields, so they are accepted and
 * ignored rather than silently claimed.
 *
 * @module context/feedback-filters
 */
import { z } from 'zod';

/** A wire value: a comma string (`"a,b"`), an array, or absent. */
const multiValue = z.union([z.string(), z.array(z.string())]).optional();

/**
 * The `filters` field of a chat request. Every dimension is optional; an absent
 * or empty one means "any". Mirrors the wire keys the shared model emits.
 */
export const chatFiltersSchema = z.object({
  source: multiValue,
  category: multiValue,
  subcategory: multiValue,
  sentiment: multiValue,
  urgent: z.union([z.boolean(), z.string()]).optional(),
  usefulness: multiValue,
}).passthrough();

export type ChatFiltersInput = z.infer<typeof chatFiltersSchema>;

/** A parsed, normalised filter set: every dimension a (possibly empty) list. */
export interface ChatFilters {
  readonly sources: readonly string[];
  readonly categories: readonly string[];
  readonly subcategories: readonly string[];
  readonly sentiments: readonly string[];
  readonly usefulness: readonly string[];
  readonly urgentOnly: boolean;
}

export const EMPTY_CHAT_FILTERS: ChatFilters = {
  sources: [], categories: [], subcategories: [], sentiments: [], usefulness: [], urgentOnly: false,
};

const TRUE_STRINGS = new Set(['true', '1', 'yes']);

/** A wire value → a de-duplicated, trimmed, non-empty list. */
function toList(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : (value ?? '').split(',');
  const seen = new Set<string>();
  for (const part of parts) {
    const text = part.trim();
    if (text) seen.add(text);
  }
  return [...seen];
}

function isTruthy(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') return value;
  return typeof value === 'string' && TRUE_STRINGS.has(value.trim().toLowerCase());
}

/** Parse the request's `filters` field (any of the accepted shapes) into lists. */
export function parseChatFilters(raw: unknown): ChatFilters {
  const parsed = chatFiltersSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_CHAT_FILTERS;
  const data = parsed.data;
  return {
    sources: toList(data.source),
    categories: toList(data.category),
    subcategories: toList(data.subcategory),
    sentiments: toList(data.sentiment),
    usefulness: toList(data.usefulness),
    urgentOnly: isTruthy(data.urgent),
  };
}

/** True when nothing narrows the set (every dimension empty). */
export function isEmptyChatFilters(filters: ChatFilters): boolean {
  return filters.sources.length === 0
    && filters.categories.length === 0
    && filters.subcategories.length === 0
    && filters.sentiments.length === 0
    && filters.usefulness.length === 0
    && !filters.urgentOnly;
}

/** The usefulness value a row filters on; a missing/blank value reads as `unscored`. */
function usefulnessValue(item: Record<string, unknown>): string {
  const raw = item.usefulness;
  return typeof raw === 'string' && raw.trim() !== '' ? raw : 'unscored';
}

function matchesList(value: unknown, allowed: readonly string[]): boolean {
  return allowed.length === 0 || (typeof value === 'string' && allowed.includes(value));
}

/**
 * True when `item` satisfies every active dimension (AND across, OR within).
 * Matches `FeedbackFilters.matches` in the Python model.
 */
export function matchesChatFilters(item: Record<string, unknown>, filters: ChatFilters): boolean {
  return matchesList(item.source_platform, filters.sources)
    && matchesList(item.category, filters.categories)
    && matchesList(item.subcategory, filters.subcategories)
    && matchesList(item.sentiment_label, filters.sentiments)
    && (filters.usefulness.length === 0 || filters.usefulness.includes(usefulnessValue(item)))
    && (!filters.urgentOnly || item.urgency === 'high');
}

/** A one-line description of the active filters for the model's context. */
export function describeChatFilters(filters: ChatFilters): string {
  const parts: string[] = [];
  if (filters.sources.length > 0) parts.push(`Sources: ${filters.sources.join(', ')}`);
  if (filters.categories.length > 0) parts.push(`Categories: ${filters.categories.join(', ')}`);
  if (filters.subcategories.length > 0) parts.push(`Subcategories: ${filters.subcategories.join(', ')}`);
  if (filters.sentiments.length > 0) parts.push(`Sentiments: ${filters.sentiments.join(', ')}`);
  if (filters.usefulness.length > 0) parts.push(`Usefulness: ${filters.usefulness.join(', ')}`);
  if (filters.urgentOnly) parts.push('Urgent only');
  return parts.join('; ');
}
