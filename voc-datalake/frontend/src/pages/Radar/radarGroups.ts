/**
 * @fileoverview Pure groupings of the Radar brand view: love / hate themes by top-level category
 * (quotes capped and said once per column), the trend over the whole window (missing days filled),
 * and releases by month.
 * @module pages/Radar/radarGroups
 */
import { utcDayBefore } from './radarReads'
import type { RadarDetail, RadarTheme } from '../../api/radarSchema'

/** At most this many quotes under one theme. */
const MAX_THEME_QUOTES = 2

/** A theme with the quotes it shows (capped, none already shown higher in its column). */
export interface ShownTheme {
  readonly theme: RadarTheme
  readonly quotes: readonly string[]
}

/** One top-level category of a love / hate column: its total and its themes, biggest first. */
export interface ThemeGroup {
  readonly category: string
  readonly total: number
  readonly themes: readonly ShownTheme[]
}

/** The quotes of `theme` not seen yet in the column, at most {@link MAX_THEME_QUOTES}; marks them seen. */
function freshQuotes(theme: RadarTheme, seen: Set<string>): string[] {
  const shown: string[] = []
  for (const quote of theme.quotes) {
    const key = quote.trim().toLowerCase()
    if (shown.length < MAX_THEME_QUOTES && key !== '' && !seen.has(key)) {
      seen.add(key)
      shown.push(quote)
    }
  }
  return shown
}

/** Themes grouped by category, groups by total (then first appearance), themes by count; quotes deduped per column. */
export function groupThemes(themes: readonly RadarTheme[]): ThemeGroup[] {
  const byCategory = new Map<string, RadarTheme[]>()
  for (const theme of themes) byCategory.set(theme.category, [...(byCategory.get(theme.category) ?? []), theme])
  const groups = [...byCategory.entries()]
    .map(([category, members]) => ({
      category,
      total: members.reduce((sum, theme) => sum + theme.count, 0),
      members: [...members].sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total)
  const seen = new Set<string>()
  return groups.map(({ category, total, members }) => ({
    category, total, themes: members.map((theme) => ({ theme, quotes: freshQuotes(theme, seen) })),
  }))
}

type TrendPoint = RadarDetail['trend'][number]

/**
 * Every day of the window, oldest first, ending today (UTC): a day without reviews is 0 reviews and
 * no sentiment. A trend day outside the window (a clock skew) is kept, so no review is hidden.
 */
export function fillWindow(trend: readonly TrendPoint[], days: number, now = new Date()): TrendPoint[] {
  const known = new Map(trend.map((point) => [point.date, point]))
  const windowDays = Array.from({ length: days }, (_, i) => utcDayBefore(now, days - 1 - i))
  const inWindow = new Set(windowDays)
  const extra = trend.filter((point) => !inWindow.has(point.date)).map((point) => point.date)
  return [...new Set([...windowDays, ...extra])].sort((a, b) => a.localeCompare(b))
    .map((date) => known.get(date) ?? { date, count: 0, avg_sentiment: null })
}

/** Items grouped by the `YYYY-MM` of their day, in the order given (newest first in, newest month first out). */
export function groupByMonth<T extends { readonly release_date: string }>(items: readonly T[]): Array<{ month: string; items: T[] }> {
  const months = new Map<string, T[]>()
  for (const item of items) {
    const month = item.release_date.slice(0, 7)
    months.set(month, [...(months.get(month) ?? []), item])
  }
  return [...months.entries()].map(([month, members]) => ({ month, items: members }))
}
