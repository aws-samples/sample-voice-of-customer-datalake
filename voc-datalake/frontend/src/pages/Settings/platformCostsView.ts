/**
 * @fileoverview The cost page's view logic (PlatformCostsSection.tsx), kept pure: the periods it offers, as UTC
 * days the route accepts (shared/platform_costs.py `parse_range`: `to` not after today, at most 92 days), and the
 * month subtotals of an entity's days. The route sums no months (its range is at most 92 days), so the page sums the
 * days it shows the way the server sums a range (`_Sum`): counts added, the priced days' dollars added exactly (in
 * millionths, the server's precision), null while no day with calls is priced, incomplete once one day is, and a
 * known zero for complete days that cost nothing.
 *
 * @module pages/Settings/platformCostsView
 */
import type { CostDay, CostRange, CostSum } from '../../api/platformCostsApi'

/** The periods offered, the first the default. Each fits the route's 92 days (`MAX_RANGE_DAYS` in
 * shared/platform_costs.py) whatever today is. */
export const COST_PERIODS = ['last30', 'thisMonth', 'lastMonth', 'last90'] as const
export type CostPeriod = typeof COST_PERIODS[number]
export const DEFAULT_COST_PERIOD: CostPeriod = 'last30'

export function isCostPeriod(value: string): value is CostPeriod {
  return COST_PERIODS.some((period) => period === value)
}

const DAY_MS = 86_400_000

/** Today as the server names it (UTC). */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

const dayAt = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const msOf = (day: string): number => Date.parse(`${day}T00:00:00Z`)

/** `period` ending on `today` (a UTC day): the last N days with today, this month so far, or last month whole. */
export function periodRange(period: CostPeriod, today: string): CostRange {
  const end = msOf(today)
  const firstOfMonth = `${today.slice(0, 7)}-01`
  switch (period) {
    case 'last30': return { from: dayAt(end - 29 * DAY_MS), to: today }
    case 'last90': return { from: dayAt(end - 89 * DAY_MS), to: today }
    case 'thisMonth': return { from: firstOfMonth, to: today }
    case 'lastMonth': {
      const lastDay = dayAt(msOf(firstOfMonth) - DAY_MS)
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay }
    }
  }
}

/** One month's sum of an entity's days. */
export interface MonthSum extends CostSum {
  /** YYYY-MM. */
  readonly month: string
}

const MICROS = 1_000_000n

/** A decimal string as millionths (the server's precision; more digits are cut, never rounded up). */
function toMicros(usd: string): bigint {
  const negative = usd.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? usd.slice(1) : usd).split('.')
  const micros = BigInt(whole) * MICROS + BigInt(fraction.slice(0, 6).padEnd(6, '0'))
  return negative ? -micros : micros
}

function microsText(micros: bigint): string {
  const negative = micros < 0n
  const value = negative ? -micros : micros
  const text = `${value / MICROS}.${(value % MICROS).toString().padStart(6, '0')}`
  return negative ? `-${text}` : text
}

function sumOf(month: string, days: readonly CostDay[]): MonthSum {
  const priced = days.flatMap((day) => (day.estimated_usd === null ? [] : [toMicros(day.estimated_usd)]))
  const micros = priced.length === 0 ? null : priced.reduce((total, part) => total + part, 0n)
  const unpriced = new Set(days.flatMap((day) => day.unpriced_models))
  const complete = days.every((day) => day.complete)
  const counted = (field: 'calls' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens') =>
    days.reduce((total, day) => total + day[field], 0)
  // (nothing to price and nothing unpriced: a known zero, as the server says it)
  const usd = micros === null && complete && unpriced.size === 0 ? 0n : micros
  return {
    month, calls: counted('calls'), input_tokens: counted('input_tokens'), output_tokens: counted('output_tokens'),
    cache_read_tokens: counted('cache_read_tokens'), cache_write_tokens: counted('cache_write_tokens'),
    estimated_usd: usd === null ? null : microsText(usd), complete,
    unpriced_models: [...unpriced].sort((a, b) => a.localeCompare(b)),
  }
}

/** Each month that has a day in `days`, in order, with its sum. */
export function monthSubtotals(days: readonly CostDay[]): MonthSum[] {
  const months = new Map<string, CostDay[]>()
  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const month = day.date.slice(0, 7)
    months.set(month, [...months.get(month) ?? [], day])
  }
  return [...months].map(([month, monthDays]) => sumOf(month, monthDays))
}

/** Whether `range` covers more than one calendar month (then each row shows its months). */
export function spansMonths({ from, to }: CostRange): boolean {
  return from.slice(0, 7) !== to.slice(0, 7)
}

/** A dollar figure for display (a number for the currency format), or null when it is unknown. */
export function toUsdNumber(usd: string | null): number | null {
  return usd === null ? null : Number(usd)
}
