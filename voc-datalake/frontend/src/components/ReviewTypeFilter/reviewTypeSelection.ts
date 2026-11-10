/**
 * @fileoverview The review-type filter shared by Problem Analysis and Categories: which
 * `feedback_type` values a page reads, how that choice sits in the URL (`types`) and how it
 * reaches the server (`dims=feedback_type:a|b|~unset`, `lambda/shared/item_filters.py`).
 *
 * A selection is the list of pressed type pills. An EMPTY selection is no type filter (every
 * review), shown as "All types"; pressing all ten pills means the same. "Problems only" is a
 * preset: the six problem types. A click on a pill while a preset is showing selects only that
 * type (one click for "only feature requests"); later clicks add or remove pills, and removing
 * the last one goes back to no filter. "Problems only" is recognised by its value, not kept as a mode:
 * pressing those six pills one by one (or opening a link listing exactly them) reads as the preset, so
 * the next click selects one type too. Kept on purpose: the URL then needs no separate preset flag.
 *
 * Each page has its own default: Problem Analysis opens on Problems only, Categories on every
 * type. An absent `types` is the page's default, `all` is no filter, a comma list is a choice.
 *
 * Reviews with no type yet (stored before the backfill) are always kept in view (`~unset`), so a
 * type filter never hides a review the classifier has not seen.
 *
 * @module components/ReviewTypeFilter/reviewTypeSelection
 */
import { FEEDBACK_TYPE_KEY, feedbackTypeCopy } from '../../api/feedbackTypes'

/** The built-in `feedback_type` values, in display order (the backend's contract). */
export const FEEDBACK_TYPES = [
  'bug', 'service_failure', 'performance', 'usability', 'pricing_billing', 'support_experience',
  'feature_request', 'praise', 'question', 'other',
] as const
export type FeedbackType = typeof FEEDBACK_TYPES[number]

/** The "Problems only" preset (Problem Analysis' default). */
export const PROBLEM_TYPES: readonly FeedbackType[] = [
  'bug', 'service_failure', 'performance', 'usability', 'pricing_billing', 'support_experience',
]

/** The pressed type pills, in display order; empty = no type filter ("All types"). */
export type TypeSelection = readonly FeedbackType[]

/** No type filter. */
export const ALL_TYPES: TypeSelection = Object.freeze([])

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

/** No type filter: nothing pressed, or every type pressed. */
export function isAllTypes(selection: TypeSelection): boolean {
  return selection.length === 0 || sameTypes(selection, FEEDBACK_TYPES)
}

/** The pills shown pressed: none for no filter (also when all ten were pressed one by one). */
export function pressedTypes(selection: TypeSelection): TypeSelection {
  return isAllTypes(selection) ? ALL_TYPES : ordered(selection)
}

/**
 * The selection a `types` URL value names: absent or unreadable = the page's default,
 * `all` = no filter, otherwise the listed types in display order.
 */
export function readTypeSelection(raw: string | null, pageDefault: TypeSelection): TypeSelection {
  if (raw === ALL_TOKEN) return ALL_TYPES
  const values = ordered((raw ?? '').split(',').filter(isFeedbackType))
  return values.length === 0 ? pageDefault : pressedTypes(values)
}

/** The `types` URL value for a selection; null when it is the page's default. */
export function writeTypeSelection(selection: TypeSelection, pageDefault: TypeSelection): string | null {
  const pressed = pressedTypes(selection)
  if (sameTypes(pressed, pressedTypes(pageDefault))) return null
  return pressed.length === 0 ? ALL_TOKEN : pressed.join(',')
}

/**
 * One pill clicked. While a preset shows (Problems only), the click selects only that type;
 * otherwise it adds or removes the pill. Removing the last pill is no filter.
 */
export function toggleType(selection: TypeSelection, type: FeedbackType): TypeSelection {
  const pressed = pressedTypes(selection)
  if (isProblemsOnly(pressed)) return [type]
  const next = pressed.includes(type) ? pressed.filter((t) => t !== type) : [...pressed, type]
  return pressedTypes(next)
}

/** The `dims` value the selection sends (untyped reviews always included); undefined for no filter. */
export function typeSelectionDims(selection: TypeSelection): string | undefined {
  const pressed = pressedTypes(selection)
  if (pressed.length === 0) return undefined
  return `${FEEDBACK_TYPE_KEY}:${[...pressed, UNSET_CHOICE].join(ANY_SEPARATOR)}`
}

/**
 * The pills' counts from a window's per-type counts (`/feedback/entities` → `dimensions.feedback_type`)
 * and its review total: each built-in type's count plus `untyped`, the reviews no type covers (never below 0).
 * A value outside the built-in types is not a pill and is not counted as untyped either.
 */
export function typeCountsFrom(byType: Readonly<Record<string, number>>, windowTotal: number): Record<string, number> {
  const entries = Object.entries(byType)
  const typed = entries.reduce((sum, [, count]) => sum + count, 0)
  return {
    ...Object.fromEntries(entries.filter(([value]) => isFeedbackType(value))),
    [UNTYPED_COUNT_KEY]: Math.max(0, windowTotal - typed),
  }
}
