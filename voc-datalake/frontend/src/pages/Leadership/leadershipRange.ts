/**
 * @fileoverview The leadership view's ranges and period labels (pure): the presets the filter row offers, each a
 * `{from, to, grain}` of whole UTC months ending with the current one, and a period's label in the reader's language
 * (`2026-11` → "Nov 2026", `2026-Q4` → "Q4 2026").
 * @module pages/Leadership/leadershipRange
 */
import type { AdoptionRange, Grain } from '../../api/adoptionApi'
import { formatCalendarMonth } from '../../utils/dateUtils'

export const RANGE_PRESETS = ['last6', 'last12', 'thisYear', 'last24'] as const
export type RangePreset = typeof RANGE_PRESETS[number]

const MONTHS_BACK: Readonly<Record<Exclude<RangePreset, 'thisYear'>, number>> = { last6: 6, last12: 12, last24: 24 }

function month(year: number, index: number): string {
  const at = new Date(Date.UTC(year, index, 1))
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}

/** The most months a range covers (lambda/shared/adoption_view.py MAX_RANGE_MONTHS). */
const MAX_RANGE_MONTHS = 24

/** The range a preset names on `today` (UTC), by `grain`. By quarter it starts on a quarter's first month, the latest
 *  one that keeps the range (to the current month) within `MAX_RANGE_MONTHS`, as the server widens it. */
export function presetRange(preset: RangePreset, grain: Grain, today: Date): AdoptionRange {
  const year = today.getUTCFullYear()
  const current = today.getUTCMonth()
  const to = month(year, current)
  const start = preset === 'thisYear' ? 0 : current - MONTHS_BACK[preset] + 1
  return { from: month(year, grain === 'quarter' ? quarterStart(start, current) : start), to, grain }
}

/** The first month of `start`'s quarter, moved on a quarter while the range to `current` would pass the bound. */
function quarterStart(start: number, current: number): number {
  const aligned = start - (((start % 3) + 3) % 3)
  const over = current - aligned + 1 - MAX_RANGE_MONTHS
  return over > 0 ? aligned + Math.ceil(over / 3) * 3 : aligned
}

const QUARTER = /^(\d{4})-Q([1-4])$/

/** A period's label: a month in the locale's short form, a quarter through `quarterLabel`, else the period itself. */
export function periodLabel(period: string, locale: string,
  quarterLabel: (quarter: string, year: string) => string): string {
  const quarter = QUARTER.exec(period)
  if (quarter) return quarterLabel(quarter[2] ?? '', quarter[1] ?? '')
  return formatCalendarMonth(period, locale, 'short')
}
