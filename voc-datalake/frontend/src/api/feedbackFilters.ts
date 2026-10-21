/**
 * One feedback filter model for the Dashboard, Categories and Problem Analysis
 * pages (and the project pre-filter / chat that reuse the panel).
 *
 * Mirrors `lambda/shared/feedback_filters.py`. The wire keys are the same in the
 * API query string and in the page URL, so a filtered page is a shareable link
 * and a deep link (`/categories?category=delivery`) selects the same filter:
 *
 *   source=a,b  category=x,y  subcategory=s  sentiment=negative,mixed
 *   urgent=true  <enrichment field>=high,unscored
 *   cf_<key>=<value>&cf_<key>=<value>   (repeated, never comma-joined)
 *
 * Custom-field values are free text that may contain commas ("Las Vegas, NV"),
 * so a multi-select custom field repeats its key instead of joining values.
 */
import { z } from 'zod'
import { ENRICHMENT_FIELDS, UNSCORED } from './enrichmentFields'

export const SENTIMENT_OPTIONS = ['positive', 'neutral', 'negative', 'mixed'] as const

export interface FeedbackFilterState {
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  readonly subcategories: readonly string[]
  readonly sentiments: readonly string[]
  readonly urgentOnly: boolean
  /** Registry field name → selected values (may include `unscored`). */
  readonly enrichment: Readonly<Record<string, readonly string[]>>
  /** custom_fields key → selected values; any value within a key, ANDed across keys. */
  readonly customFields: Readonly<Record<string, readonly string[]>>
}

/** A query param value: one string, or a repeated key. */
export type FilterParamValue = string | readonly string[]

export const EMPTY_FEEDBACK_FILTERS: FeedbackFilterState = Object.freeze({
  sources: [],
  categories: [],
  subcategories: [],
  sentiments: [],
  urgentOnly: false,
  enrichment: {},
  customFields: {},
})

/** The plain multi-value dimensions and their wire keys. */
export const LIST_DIMENSIONS = [
  { key: 'sources', param: 'source' },
  { key: 'categories', param: 'category' },
  { key: 'subcategories', param: 'subcategory' },
  { key: 'sentiments', param: 'sentiment' },
] as const

export type ListDimension = (typeof LIST_DIMENSIONS)[number]['key']

const CUSTOM_FIELD_PREFIX = 'cf_'

const stringList = z.array(z.string()).catch([])

/** Lenient: any malformed part degrades to "no filter" rather than throwing. */
const FilterStateSchema = z.object({
  sources: stringList,
  categories: stringList,
  subcategories: stringList,
  sentiments: stringList,
  urgentOnly: z.boolean().catch(false),
  enrichment: z.record(z.string(), stringList).catch({}),
  // A plain string is the pre-multi-select shape (still in some people's
  // localStorage): it becomes a one-value list.
  customFields: z
    .record(z.string(), z.union([z.string().transform((value) => [value]), z.array(z.string())]))
    .catch({}),
})

/** Drop empty values, and keys left with none (an empty selection is "any"). */
function cleanCustomFields(raw: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, values] of Object.entries(raw)) {
    const kept = [...new Set(values.filter((value) => value !== ''))]
    if (key && kept.length > 0) out[key] = kept
  }
  return out
}

/** Keep only registry fields and their declared values (plus `unscored`). */
function cleanEnrichment(raw: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const field of ENRICHMENT_FIELDS) {
    const allowed = new Set([...field.values, UNSCORED])
    const values = (raw[field.name] ?? []).filter((v) => allowed.has(v))
    if (values.length > 0) out[field.name] = values
  }
  return out
}

/** Validate untrusted filter state (persisted storage, older shapes). */
export function normalizeFeedbackFilters(raw: unknown): FeedbackFilterState {
  const parsed = FilterStateSchema.safeParse(raw ?? {})
  if (!parsed.success) return EMPTY_FEEDBACK_FILTERS
  return {
    ...parsed.data,
    enrichment: cleanEnrichment(parsed.data.enrichment),
    customFields: cleanCustomFields(parsed.data.customFields),
  }
}

export function toggleValue(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** Number of active dimensions (a multi-select counts once), for the panel badge. */
export function countActiveFilters(filters: FeedbackFilterState): number {
  const lists = LIST_DIMENSIONS.filter(({ key }) => filters[key].length > 0).length
  const enrichment = Object.values(filters.enrichment).filter((v) => v.length > 0).length
  const custom = Object.values(filters.customFields).filter((values) => values.length > 0).length
  return lists + enrichment + custom + (filters.urgentOnly ? 1 : 0)
}

export function hasActiveFilters(filters: FeedbackFilterState): boolean {
  return countActiveFilters(filters) > 0
}

/**
 * Query params for the filter-aware endpoints. Empty dimensions are omitted.
 * Custom fields map to a LIST, sent as a repeated key (`buildSearchParams` and
 * `filteredSearchParams` both append each value); everything else is a string.
 */
export function toFeedbackQueryParams(filters: FeedbackFilterState): Record<string, FilterParamValue> {
  const params: Record<string, FilterParamValue> = {}
  for (const { key, param } of LIST_DIMENSIONS) {
    if (filters[key].length > 0) params[param] = filters[key].join(',')
  }
  if (filters.urgentOnly) params.urgent = 'true'
  for (const [name, values] of Object.entries(filters.enrichment)) {
    if (values.length > 0) params[name] = values.join(',')
  }
  for (const [key, values] of Object.entries(filters.customFields)) {
    if (values.length > 0) params[`${CUSTOM_FIELD_PREFIX}${key}`] = values
  }
  return params
}

function splitParam(value: string | null): string[] {
  if (value === null || value === '') return []
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

/** `cf_<key>` params grouped by key; a repeated key is several values. */
function customFieldsFromParams(params: URLSearchParams): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [rawKey, value] of params.entries()) {
    if (!rawKey.startsWith(CUSTOM_FIELD_PREFIX) || value === '') continue
    const key = rawKey.slice(CUSTOM_FIELD_PREFIX.length)
    if (key) out[key] = [...(out[key] ?? []), value]
  }
  return out
}

/** Parse filters from a URL query string (the same keys the API takes). */
export function feedbackFiltersFromSearchParams(params: URLSearchParams): FeedbackFilterState {
  const enrichment: Record<string, string[]> = {}
  for (const field of ENRICHMENT_FIELDS) {
    const values = splitParam(params.get(field.name))
    if (values.length > 0) enrichment[field.name] = values
  }
  return normalizeFeedbackFilters({
    sources: splitParam(params.get('source')),
    categories: splitParam(params.get('category')),
    subcategories: splitParam(params.get('subcategory')),
    sentiments: splitParam(params.get('sentiment')).filter((s) => SENTIMENT_OPTIONS.some((o) => o === s)),
    urgentOnly: params.get('urgent') === 'true',
    enrichment,
    customFields: customFieldsFromParams(params),
  })
}

/** Every URL key the filter model owns, so URL sync can leave other keys alone. */
export function isFilterParam(key: string): boolean {
  return (
    LIST_DIMENSIONS.some(({ param }) => param === key)
    || key === 'urgent'
    || ENRICHMENT_FIELDS.some((f) => f.name === key)
    || key.startsWith(CUSTOM_FIELD_PREFIX)
  )
}

/**
 * A query string from plain params (null/undefined dropped) plus the filters.
 * Shared by the filter-aware API modules so they encode filters identically.
 */
export function filteredSearchParams(
  params: Readonly<Record<string, string | number | undefined | null>>,
  filters: FeedbackFilterState,
): URLSearchParams {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null) search.set(key, String(value))
  }
  for (const [key, value] of Object.entries(toFeedbackQueryParams(filters))) {
    search.delete(key)
    for (const item of typeof value === 'string' ? [value] : value) search.append(key, item)
  }
  return search
}

const byLocale = (a: string, b: string) => a.localeCompare(b)

/** Stable string form for query keys and equality checks (selection order ignored). */
export function filtersKey(filters: FeedbackFilterState): string {
  const params = toFeedbackQueryParams(filters)
  const sorted: Record<string, FilterParamValue> = {}
  for (const key of Object.keys(params).sort(byLocale)) {
    const value = params[key]
    sorted[key] = typeof value === 'string' ? value.split(',').sort(byLocale).join(',') : [...value].sort(byLocale)
  }
  return JSON.stringify(sorted)
}
