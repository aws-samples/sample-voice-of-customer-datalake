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

/** The range a preset names on `today` (UTC), by `grain`. */
export function presetRange(preset: RangePreset, grain: Grain, today: Date): AdoptionRange {
  const year = today.getUTCFullYear()
  const current = today.getUTCMonth()
  const to = month(year, current)
  const from = preset === 'thisYear' ? month(year, 0) : month(year, current - MONTHS_BACK[preset] + 1)
  return { from, to, grain }
}

const QUARTER = /^(\d{4})-Q([1-4])$/

/** A period's label: a month in the locale's short form, a quarter through `quarterLabel`, else the period itself. */
export function periodLabel(period: string, locale: string,
  quarterLabel: (quarter: string, year: string) => string): string {
  const quarter = QUARTER.exec(period)
  if (quarter) return quarterLabel(quarter[2] ?? '', quarter[1] ?? '')
  return formatCalendarMonth(period, locale, 'short')
}
