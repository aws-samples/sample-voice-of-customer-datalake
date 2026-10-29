/**
 * @fileoverview The review-type filter of Problem Analysis: which `feedback_type`
 * values the tree reads, how that choice sits in the URL (`types`) and how it reaches
 * the server (`dims=feedback_type:a|b|~unset`, `lambda/shared/item_filters.py`).
 *
 * The default is "Problems only": the six problem types. Praise, questions, feature
 * requests and other reviews are hidden until the reader turns them on. Reviews with no
 * type yet (stored before the backfill) are always kept in view (`~unset`), so the
 * default never hides a review the classifier has not seen.
 *
 * @module pages/ProblemAnalysis/feedbackTypes
 */
import { FEEDBACK_TYPE_KEY, feedbackTypeCopy } from '../../api/feedbackTypes'

/** The built-in `feedback_type` values, in display order (the backend's contract). */
export const FEEDBACK_TYPES = [
  'bug', 'service_failure', 'performance', 'usability', 'pricing_billing', 'support_experience',
  'feature_request', 'praise', 'question', 'other',
] as const
export type FeedbackType = typeof FEEDBACK_TYPES[number]

/** "Problems only": the default selection. */
export const PROBLEM_TYPES: readonly FeedbackType[] = [
  'bug', 'service_failure', 'performance', 'usability', 'pricing_billing', 'support_experience',
]

/** The chosen types, in display order; every type = no filter ("All types"). */
export type TypeSelection = readonly FeedbackType[]

/** `type_counts`' bucket for reviews with no type yet. */
export const UNTYPED_COUNT_KEY = 'untyped'

const ANY_SEPARATOR = '|'
const UNSET_CHOICE = '~unset'
const ALL_TOKEN = 'all'

/** The chip label key of a type (common.json → feedbackTypes.*, `api/feedbackTypes.ts`). */
export function feedbackTypeLabelKey(type: FeedbackType): string {
  return feedbackTypeCopy(type)?.labelKey ?? type
}

function isFeedbackType(value: string): value is FeedbackType {
  return FEEDBACK_TYPES.some((type) => type === value)
}

/** In display order, without repeats. */
function ordered(values: readonly FeedbackType[]): FeedbackType[] {
  return FEEDBACK_TYPES.filter((type) => values.includes(type))
}

function sameTypes(a: readonly FeedbackType[], b: readonly FeedbackType[]): boolean {
  const left = ordered(a)
  const right = ordered(b)
  return left.length === right.length && left.every((type, i) => type === right[i])
}

export function isProblemsOnly(selection: TypeSelection): boolean {
  return sameTypes(selection, PROBLEM_TYPES)
}

export function isAllTypes(selection: TypeSelection): boolean {
  return sameTypes(selection, FEEDBACK_TYPES)
}

/** The selection a `types` URL value names: `all` = every type; absent or unreadable = Problems only. */
export function readTypeSelection(raw: string | null): TypeSelection {
  if (raw === ALL_TOKEN) return FEEDBACK_TYPES
  const values = ordered((raw ?? '').split(',').filter(isFeedbackType))
  return values.length === 0 ? PROBLEM_TYPES : values
}

/** The `types` URL value for a selection; null for the default (Problems only). */
export function writeTypeSelection(selection: TypeSelection): string | null {
  if (isProblemsOnly(selection)) return null
  return isAllTypes(selection) ? ALL_TOKEN : ordered(selection).join(',')
}

/** One chip clicked; a choice emptied by the click falls back to the default. */
export function toggleType(selection: TypeSelection, type: FeedbackType): TypeSelection {
  const next = selection.includes(type) ? selection.filter((t) => t !== type) : [...selection, type]
  return next.length === 0 ? PROBLEM_TYPES : ordered(next)
}

/** The `dims` value the selection sends (untyped reviews always included); undefined for every type. */
export function typeSelectionDims(selection: TypeSelection): string | undefined {
  if (isAllTypes(selection)) return undefined
  return `${FEEDBACK_TYPE_KEY}:${[...ordered(selection), UNSET_CHOICE].join(ANY_SEPARATOR)}`
}
