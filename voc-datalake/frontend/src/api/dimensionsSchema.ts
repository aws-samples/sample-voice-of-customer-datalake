/**
 * @fileoverview Feedback dimensions and tags — the wire shapes and their lenient
 * normalizers.
 *
 * A dimension is an admin-defined axis (product, module, user type …) with a
 * closed list of values; a child dimension narrows its values by the parent's
 * value (`parent` + `parent_value`). Tags are free-form labels. The backend
 * (`lambda/shared/dimension_config.py`) is the authority on every rule below;
 * the SPA mirrors the limits only to refuse a doomed save before sending it.
 *
 * Every read goes through a `.catch`-defaulted schema, so a drifted row costs
 * exactly itself and never blanks a page.
 *
 * @module api/dimensionsSchema
 */
import { z } from 'zod'
import { parsedList } from './schemaList'
import { nonBlankStringList } from './lenientFields'
import { isRecord } from '../lib/typeGuards'

// ── Limits mirrored from shared/dimension_config.py ─────────────────────────
export const MAX_DIMENSIONS = 10
export const MAX_DIMENSION_VALUES = 200
export const MAX_LABEL_CHARS = 64
export const MAX_DESCRIPTION_CHARS = 300
export const MAX_TAGS = 20
export const DIMENSION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/
export const DIMENSION_VALUE_RE = /^[^\s#,:]{1,64}$/
// The backend TAG_RE: no leading space, no control characters, no "#", "," or ":".
const TAG_RE = /^[^\s#,:][^#,:\p{Cc}]{0,63}$/u
/** Item attributes and query parameters a dimension key must not shadow. */
export const RESERVED_DIMENSION_KEYS: ReadonlySet<string> = new Set([
  'category', 'subcategory', 'source', 'channel', 'tag', 'tags',
  'sentiment', 'urgency', 'days', 'limit', 'offset', 'q',
])

// ── Config ──────────────────────────────────────────────────────────────────
export interface DimensionValue {
  name: string
  label?: string
  description?: string
  parent_value?: string
}

export interface Dimension {
  key: string
  label: string
  description?: string
  infer: boolean
  parent?: string
  values: DimensionValue[]
}

const optionalText = z.string().trim().min(1).optional().catch(undefined)

const DimensionValueSchema = z.object({
  name: z.string().trim().min(1),
  label: optionalText,
  description: optionalText,
  parent_value: optionalText,
}).transform((value): DimensionValue => ({
  name: value.name,
  ...(value.label === undefined ? {} : { label: value.label }),
  ...(value.description === undefined ? {} : { description: value.description }),
  ...(value.parent_value === undefined ? {} : { parent_value: value.parent_value }),
}))

const DimensionSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().catch(''),
  description: optionalText,
  infer: z.boolean().catch(true),
  parent: optionalText,
  values: parsedList(DimensionValueSchema),
}).transform((dimension): Dimension => ({
  key: dimension.key,
  label: dimension.label === '' ? dimension.key : dimension.label,
  infer: dimension.infer,
  values: dimension.values,
  ...(dimension.description === undefined ? {} : { description: dimension.description }),
  ...(dimension.parent === undefined ? {} : { parent: dimension.parent }),
}))

const DimensionsEnvelopeSchema = z.object({
  dimensions: parsedList(DimensionSchema),
  updated_at: optionalText,
}).catch({ dimensions: [], updated_at: undefined })

export interface DimensionsConfig {
  dimensions: Dimension[]
  updatedAt?: string
}

/** `GET /settings/dimensions` (and the PUT echo): a missing or junk list reads as none. */
export function normalizeDimensionsConfig(raw: unknown): DimensionsConfig {
  const { dimensions, updated_at: updatedAt } = DimensionsEnvelopeSchema.parse(raw)
  return updatedAt === undefined ? { dimensions } : { dimensions, updatedAt }
}

/** The display label of a value (its label, else its name). */
export function valueLabel(dimension: Dimension, name: string): string {
  return dimension.values.find((v) => v.name === name)?.label ?? name
}

/**
 * The values of `dimension` that may sit under the parent's `parentValue`:
 * a value with no `parent_value` belongs under every parent value; with no
 * parent value chosen every value is offered.
 */
export function valuesUnder(dimension: Dimension, parentValue: string | undefined): DimensionValue[] {
  if (parentValue === undefined || parentValue === '') return dimension.values
  return dimension.values.filter((v) => v.parent_value === undefined || v.parent_value === parentValue)
}

/** Parents before children, so a parent's selection can narrow its child. */
export function orderedDimensions(dimensions: readonly Dimension[]): Dimension[] {
  return [
    ...dimensions.filter((d) => d.parent === undefined),
    ...dimensions.filter((d) => d.parent !== undefined),
  ]
}

/**
 * The selection with every child value that no longer fits its parent's value
 * removed (after a parent changes) and every unknown key dropped.
 */
export function pruneSelection(
  dimensions: readonly Dimension[],
  selection: Readonly<Record<string, string>>,
): Record<string, string> {
  return orderedDimensions(dimensions).reduce<Record<string, string>>((acc, dimension) => {
    const value = selection[dimension.key]
    if (value === undefined || value === '') return acc
    const parentValue = dimension.parent === undefined ? undefined : acc[dimension.parent]
    const fits = valuesUnder(dimension, parentValue).some((v) => v.name === value)
    return fits ? { ...acc, [dimension.key]: value } : acc
  }, {})
}

/** `selection` with `key` set (or cleared), then pruned against the parent links. */
export function withDimensionValue(
  dimensions: readonly Dimension[],
  selection: Readonly<Record<string, string>>,
  key: string,
  value: string | undefined,
): Record<string, string> {
  const rest = Object.fromEntries(Object.entries(selection).filter(([k]) => k !== key))
  return pruneSelection(dimensions, value === undefined ? rest : { ...rest, [key]: value })
}

// ── The `dims` query parameter ──────────────────────────────────────────────

/** `{product: 'app', module: 'login'}` → `module:login,product:app` (sorted: stable cache keys); `undefined` when empty. */
export function serializeDims(selection: Readonly<Record<string, string>>): string | undefined {
  const pairs = Object.entries(selection)
    .filter(([key, value]) => DIMENSION_KEY_RE.test(key) && DIMENSION_VALUE_RE.test(value))
    .map(([key, value]) => `${key}:${value}`)
    .sort((a, b) => a.localeCompare(b))
  return pairs.length === 0 ? undefined : pairs.join(',')
}

/** The inverse of {@link serializeDims}, lenient: a malformed pair is skipped, not fatal (it came from a URL). */
export function parseDims(raw: string | null | undefined): Record<string, string> {
  if (raw == null || raw.trim() === '') return {}
  return raw.split(',').reduce<Record<string, string>>((acc, pair) => {
    const [key = '', value = ''] = pair.trim().split(':', 2)
    const valid = DIMENSION_KEY_RE.test(key) && DIMENSION_VALUE_RE.test(value) && !(key in acc)
    return valid ? { ...acc, [key]: value } : acc
  }, {})
}

// ── Tags ────────────────────────────────────────────────────────────────────

function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag)
}

/**
 * Text the user typed (`billing, refund; vip`) as the tags list the backend
 * would store: trimmed, blanks dropped, repeats dropped ignoring case (the
 * first spelling kept). Invalid tags are returned separately so the form can
 * say which one is wrong instead of sending it.
 */
export function parseTagInput(text: string): { tags: string[]; invalid: string[] } {
  const parts = text.split(/[,;]/).map((part) => part.trim()).filter((part) => part !== '')
  return parts.reduce<{ tags: string[]; invalid: string[] }>((acc, part) => {
    if (!isValidTag(part)) return { ...acc, invalid: [...acc.invalid, part] }
    const seen = acc.tags.some((tag) => tag.toLowerCase() === part.toLowerCase())
    return seen ? acc : { ...acc, tags: [...acc.tags, part] }
  }, { tags: [], invalid: [] })
}

/** A tags list from the wire: strings only, blanks dropped. */
export const TagsSchema = nonBlankStringList

/** A `{key: value}` map from the wire: string values only. */
export const StringMapSchema = z.unknown().optional().transform((value): Record<string, string> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''),
  )
})

/** {@link StringMapSchema} that leaves an absent field absent (so a record round-trips unchanged). */
export const OptionalStringMapSchema = z.unknown().optional().transform((value) =>
  (value === undefined ? undefined : StringMapSchema.parse(value)))

/** {@link TagsSchema} that leaves an absent field absent. */
export const OptionalTagsSchema = z.unknown().optional().transform((value) =>
  (value === undefined ? undefined : TagsSchema.parse(value)))

// ── GET /metrics/dimensions ─────────────────────────────────────────────────

const countField = z.unknown().optional().transform((value) => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
})

const BucketSchema = z.object({
  count: countField,
  positive: countField,
  negative: countField,
  neutral: countField,
  mixed: countField,
}).catch({ count: 0, positive: 0, negative: 0, neutral: 0, mixed: 0 })

export type DimensionBucket = z.infer<typeof BucketSchema>

const DimensionMetricsSchema = z.object({
  key: z.string().catch(''),
  period_days: countField,
  is_partial: z.boolean().catch(false),
  values: z.record(z.string(), z.unknown()).catch({}),
  unassigned: countField,
}).catch({ key: '', period_days: 0, is_partial: false, values: {}, unassigned: 0 })

export interface DimensionMetrics {
  key: string
  periodDays: number
  isPartial: boolean
  /** Largest first, ties by name. */
  values: Array<{ name: string } & DimensionBucket>
  unassigned: number
}

export function normalizeDimensionMetrics(raw: unknown): DimensionMetrics {
  const parsed = DimensionMetricsSchema.parse(raw)
  const values = Object.entries(parsed.values)
    .map(([name, bucket]) => ({ name, ...BucketSchema.parse(bucket) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return {
    key: parsed.key,
    periodDays: parsed.period_days,
    isPartial: parsed.is_partial,
    values,
    unassigned: parsed.unassigned,
  }
}

// ── GET /feedback/entities additions ────────────────────────────────────────

const CountMapSchema = z.unknown().optional().transform((value): Record<string, number> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([name, n]) => {
    const parsed = countField.parse(n)
    return name !== '' && parsed > 0 ? [[name, parsed]] : []
  }))
})

const NestedCountMapSchema = z.unknown().optional().transform((value): Record<string, Record<string, number>> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, counts]) => [key, CountMapSchema.parse(counts)]))
})

export interface EntityExtras {
  channels: Record<string, number>
  tags: Record<string, number>
  dimensions: Record<string, Record<string, number>>
}

/**
 * `channels`, `tags` and `dimensions` of an entities response. Read at the top
 * level, or inside `entities` when a server nests them there; absent from an
 * older API they read as empty.
 */
export function normalizeEntityExtras(raw: unknown): EntityExtras {
  const top = isRecord(raw) ? raw : {}
  const nested = isRecord(top['entities']) ? top['entities'] : {}
  const pick = (field: string): unknown => top[field] ?? nested[field]
  return {
    channels: CountMapSchema.parse(pick('channels')),
    tags: CountMapSchema.parse(pick('tags')),
    dimensions: NestedCountMapSchema.parse(pick('dimensions')),
  }
}

/** Keys of a count map, largest count first, ties by name. */
export function rankedNames(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts)
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([name]) => name)
}

// ── PUT /feedback/{id}/dimensions ───────────────────────────────────────────

const EditResponseSchema = z.object({
  feedback_id: z.string().catch(''),
  dimensions: StringMapSchema,
  tags: TagsSchema,
}).catch({ feedback_id: '', dimensions: {}, tags: [] })

export type FeedbackDimensionsResult = z.infer<typeof EditResponseSchema>

export function normalizeDimensionsEdit(raw: unknown): FeedbackDimensionsResult {
  return EditResponseSchema.parse(raw)
}
