/**
 * The cost page's view logic: the periods it offers (UTC days, never past today, never over the route's 92), and the
 * month subtotals summed from the days the route answers, as the server sums a range (shared/platform_costs.py
 * `_Sum`): exact to the millionth, unknown while nothing with calls is priced, incomplete once one day is.
 */
import { describe, expect, it } from 'vitest'
import { COST_PERIODS, isCostPeriod, monthSubtotals, periodRange, toUsdNumber, utcToday } from './platformCostsView'

/** `MAX_RANGE_DAYS` in shared/platform_costs.py. */
const MAX_RANGE_DAYS = 92
const daysIn = ({ from, to }: Readonly<{ from: string; to: string }>) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

const day = (date: string, usd: string | null, complete = true, unpriced: string[] = []) => ({
  date, calls: 2, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 0,
  estimated_usd: usd, complete, unpriced_models: unpriced,
})

describe('periodRange', () => {
  it.each([
    ['last30', '2026-11-26', { from: '2026-10-28', to: '2026-11-26' }],
    ['thisMonth', '2026-11-26', { from: '2026-11-01', to: '2026-11-26' }],
    ['lastMonth', '2026-11-26', { from: '2026-10-01', to: '2026-10-31' }],
    ['lastMonth', '2026-01-05', { from: '2025-12-01', to: '2025-12-31' }],
    ['lastMonth', '2028-03-01', { from: '2028-02-01', to: '2028-02-29' }],
    ['last90', '2026-11-26', { from: '2026-08-29', to: '2026-11-26' }],
  ] as const)('%s on %s is %o', (period, today, expected) => {
    expect(periodRange(period, today)).toStrictEqual(expected)
  })

  it('never asks for more than the route reads, nor a day after today', () => {
    for (const period of COST_PERIODS) {
      for (const today of ['2026-01-01', '2026-03-31', '2026-12-31', '2028-02-29']) {
        const range = periodRange(period, today)
        expect(daysIn(range), `${period} on ${today}`).toBeLessThanOrEqual(MAX_RANGE_DAYS)
        expect(range.to <= today && range.from <= range.to, `${period} on ${today}`).toBe(true)
      }
    }
  })

  it('reads today in UTC, and knows its periods', () => {
    expect(utcToday(new Date('2026-11-26T23:30:00-05:00'))).toBe('2026-11-27')
    expect([isCostPeriod('last30'), isCostPeriod('forever')]).toStrictEqual([true, false])
  })
})

describe('monthSubtotals', () => {
  it('sums each month exactly, in order', () => {
    const months = monthSubtotals([day('2026-10-30', '0.100000'), day('2026-10-31', '0.200000'), day('2026-11-01', '1.000001')])
    expect(months).toStrictEqual([
      { month: '2026-10', calls: 4, input_tokens: 200, output_tokens: 20, cache_read_tokens: 2, cache_write_tokens: 0,
        estimated_usd: '0.300000', complete: true, unpriced_models: [] },
      { month: '2026-11', calls: 2, input_tokens: 100, output_tokens: 10, cache_read_tokens: 1, cache_write_tokens: 0,
        estimated_usd: '1.000001', complete: true, unpriced_models: [] },
    ])
  })

  it('keeps the priced part of a month with an unpriced day, marked incomplete with its models', () => {
    const [month] = monthSubtotals([day('2026-11-02', '0.500000'), day('2026-11-03', null, false, ['model-beta'])])
    expect(month).toMatchObject({ estimated_usd: '0.500000', complete: false, unpriced_models: ['model-beta'] })
  })

  it('leaves a month with nothing priced unknown, and a month of complete zero days a known zero', () => {
    expect(monthSubtotals([day('2026-11-02', null, false, ['model-beta'])])[0]?.estimated_usd).toBeNull()
    expect(monthSubtotals([day('2026-11-02', '0.000000')])[0]?.estimated_usd).toBe('0.000000')
    expect(monthSubtotals([])).toStrictEqual([])
  })
})

describe('toUsdNumber', () => {
  it('reads a decimal string for display, and null as null', () => {
    expect([toUsdNumber('12.345678'), toUsdNumber(null), toUsdNumber('0.000000')]).toStrictEqual([12.345678, null, 0])
  })
})
