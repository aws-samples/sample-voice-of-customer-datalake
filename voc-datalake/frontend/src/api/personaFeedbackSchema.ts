/**
 * @fileoverview Runtime normalization for the persona source-feedback routes.
 *
 * - GET  /projects/{id}/personas/{persona_id}/feedback — one page of the reviews a
 *   persona cites ('cited') or that its generation batch read ('used').
 * - POST /projects/{id}/personas/preview-feedback — how many reviews a persona
 *   generation with the given filters would draw from.
 *
 * Lenient like the other api/ boundaries: a malformed part degrades to a safe
 * default instead of throwing, so one bad field cannot blank the modal or the
 * wizard step that reads it.
 *
 * @module api/personaFeedbackSchema
 */
import { z } from 'zod'
import { normalizeFeedbackItems } from './feedbackSchema'
import { asRecord, displayString } from './wireRecord'
import type { FeedbackItem, PersonaFeedbackProvenance } from './types'

/** The two id lists a persona records, in the order the modal's tabs show them. */
export const PERSONA_FEEDBACK_SCOPES = ['cited', 'used'] as const
export type PersonaFeedbackScope = (typeof PERSONA_FEEDBACK_SCOPES)[number]

const count = z.number().int().nonnegative()

/**
 * Strict inside, lenient at the edge (see `optionalProvenanceSchema`): a
 * provenance whose counts cannot be read is dropped whole rather than shown with
 * a zero standing in for the missing number.
 */
const provenanceSchema = z.object({
  items_used: count,
  items_matched: count,
  matched_is_lower_bound: z.boolean().catch(false),
  sample_limit: count.catch(0),
})

/** A persona row's `feedback_provenance`: absent, null or malformed reads as undefined. */
export const optionalProvenanceSchema = provenanceSchema.optional().catch(undefined)

/** A feedback row on a source-feedback page. */
export interface PersonaSourceFeedbackItem extends FeedbackItem {
  /**
   * The row's `date` partition attribute (YYYY-MM-DD). Kept because it is the
   * fallback review date when `source_created_at` is empty; FeedbackItemSchema
   * strips it.
   */
  readonly date?: string
}

export interface PersonaSourceFeedbackPage {
  /** False for a persona generated before source tracking: nothing was recorded. */
  readonly available: boolean
  readonly scope: PersonaFeedbackScope
  /** Ids recorded for this scope, including ones whose feedback was deleted since. */
  readonly total: number
  readonly offset: number
  readonly items: PersonaSourceFeedbackItem[]
  /** Ids on this page whose feedback was deleted since generation. */
  readonly missing: number
  readonly provenance: PersonaFeedbackProvenance | null
}

/**
 * 'estimate' scales a random sample (~0.3s); 'exact' reads every matching review
 * (~4-7s on a 40k-review corpus). The wizard asks for both at once.
 */
export const PERSONA_PREVIEW_MODES = ['exact', 'estimate'] as const
export type PersonaPreviewMode = (typeof PERSONA_PREVIEW_MODES)[number]

export interface PersonaFeedbackPreview {
  /**
   * Reviews matching the filters; null when the response did not say, or when an
   * estimate's sample was too thin to give one.
   */
  readonly matched: number | null
  /** The count stopped at a row cap: there are at least `matched`. */
  readonly matched_is_lower_bound: boolean
  /** How many of them persona generation samples; null when the response did not say. */
  readonly sample_limit: number | null
  /**
   * `matched` is a sampled estimate (rounded), not a count. False whenever the
   * server answered an estimate request from an exact count it already had.
   */
  readonly estimated: boolean
}

/** Non-objects (null, arrays, strings) parse as an empty record, so every field defaults. */
const asRecordOrEmpty = (value: unknown): Record<string, unknown> => asRecord(value) ?? {}

const SourceFeedbackPageSchema = z.preprocess(asRecordOrEmpty, z.object({
  // Unreadable means "nothing to show", the same answer a legacy persona gets.
  available: z.boolean().catch(false),
  scope: z.enum(PERSONA_FEEDBACK_SCOPES).catch('cited'),
  total: count.catch(0),
  offset: count.catch(0),
  items: z.array(z.unknown()).catch(() => []),
  missing: count.catch(0),
  provenance: provenanceSchema.nullable().catch(null),
}))

const FeedbackPreviewSchema = z.preprocess(asRecordOrEmpty, z.object({
  // Null rather than 0: zero is a real answer ("generation will fail"), and an
  // unreadable count must not be mistaken for it.
  matched: count.nullable().catch(null),
  matched_is_lower_bound: z.boolean().catch(false),
  sample_limit: count.nullable().catch(null),
  // Absent from older servers, whose counts were always exact.
  estimated: z.boolean().catch(false),
}))

/** Feedback rows, dropping entries that are not objects at all. */
function normalizeSourceItems(rawItems: readonly unknown[]): PersonaSourceFeedbackItem[] {
  const records = rawItems.flatMap((item) => {
    const record = asRecord(item)
    return record === null ? [] : [record]
  })
  return normalizeFeedbackItems(records).map((item, index) => {
    const date = displayString(records[index]?.date)
    return date === '' ? item : { ...item, date }
  })
}

/** Normalize one page of GET /projects/{id}/personas/{persona_id}/feedback. */
export function normalizePersonaSourceFeedback(raw: unknown): PersonaSourceFeedbackPage {
  const { items, ...page } = SourceFeedbackPageSchema.parse(raw)
  return { ...page, items: normalizeSourceItems(items) }
}

/** Normalize the POST /projects/{id}/personas/preview-feedback response. */
export function normalizePersonaFeedbackPreview(raw: unknown): PersonaFeedbackPreview {
  return FeedbackPreviewSchema.parse(raw)
}
