/**
 * @fileoverview The order a category breakdown is shown in: largest first, ties
 * by name, and the "Other" row (every review outside the configured categories)
 * always last — it is the remainder, not a theme to rank against the others.
 *
 * @module utils/categoryOrder
 */
import { OTHER_CATEGORY } from './displayLabels'

type Entry = [string, number]

/** Largest first, ties by name: the same counts always give the same order (and colours). */
function bySizeThenName([nameA, a]: Entry, [nameB, b]: Entry): number {
  return b - a || nameA.localeCompare(nameB)
}

function otherLast([nameA]: Entry, [nameB]: Entry): number {
  return Number(nameA === OTHER_CATEGORY) - Number(nameB === OTHER_CATEGORY)
}

/** `[name, count]` pairs in display order (a new array; the input is untouched). */
export function rankCategoryEntries(entries: readonly (readonly [string, number])[]): Entry[] {
  return entries.map(([name, count]): Entry => [name, count]).sort((a, b) => otherLast(a, b) || bySizeThenName(a, b))
}

/**
 * The first `limit` rows of a breakdown by size, with "Other" (when it makes the
 * cut) moved to the end — the Dashboard's top-categories chart.
 */
export function topCategoryEntries(entries: readonly (readonly [string, number])[], limit: number): Entry[] {
  const bySize = entries.map(([name, count]): Entry => [name, count]).sort(bySizeThenName).slice(0, limit)
  return rankCategoryEntries(bySize)
}
