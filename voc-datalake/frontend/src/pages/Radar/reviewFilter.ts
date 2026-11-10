/**
 * @fileoverview The reviews modal's filter as chips: which chips a filter shows, and the
 * filter left after clearing one (pure, so the modal stays a thin view).
 * @module pages/Radar/reviewFilter
 */
import type { RadarReviewFilter } from '../../api/radarApi'

export type ReviewChipKey = 'category' | 'subcategory' | 'sentiment' | 'day'

interface ReviewChip {
  readonly key: ReviewChipKey
  /** The raw value; `''` for "no subcategory". */
  readonly value: string
}

const CHIP_ORDER: readonly ReviewChipKey[] = ['category', 'subcategory', 'sentiment', 'day']

/** The active filters, in display order. */
export function reviewChips(filter: RadarReviewFilter): ReviewChip[] {
  return CHIP_ORDER.flatMap((key) => {
    const value = filter[key]
    return value === undefined ? [] : [{ key, value }]
  })
}

/** The filter without `key`. Clearing the category clears its subcategory too (one names the other). */
export function withoutChip(filter: RadarReviewFilter, key: ReviewChipKey): RadarReviewFilter {
  const keep = (name: ReviewChipKey) => name !== key && !(key === 'category' && name === 'subcategory')
  return {
    category: keep('category') ? filter.category : undefined,
    subcategory: keep('subcategory') ? filter.subcategory : undefined,
    sentiment: keep('sentiment') ? filter.sentiment : undefined,
    day: keep('day') ? filter.day : undefined,
  }
}
