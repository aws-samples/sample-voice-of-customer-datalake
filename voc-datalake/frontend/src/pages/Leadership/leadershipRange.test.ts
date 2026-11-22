/** The leadership view's ranges and period labels (leadershipRange.ts). */
import { describe, expect, it } from 'vitest'
import { periodLabel, presetRange } from './leadershipRange'

const TODAY = new Date(Date.UTC(2026, 10, 21))

/** The months from `from` to `to`, both included (YYYY-MM). */
function monthsCovered(from: string, to: string): number {
  const [fromYear = 0, fromMonth = 0] = from.split('-').map(Number)
  const [toYear = 0, toMonth = 0] = to.split('-').map(Number)
  return (toYear - fromYear) * 12 + toMonth - fromMonth + 1
}

describe('presetRange', () => {
  it.each([
    ['last6', '2026-06'], ['last12', '2025-12'], ['thisYear', '2026-01'], ['last24', '2024-12'],
  ] as const)('by month, %s starts at %s and ends with the current month', (preset, from) => {
    expect(presetRange(preset, 'month', TODAY)).toStrictEqual({ from, to: '2026-11', grain: 'month' })
  })

  it.each([
    ['last6', '2026-04'], ['last12', '2025-10'], ['thisYear', '2026-01'], ['last24', '2025-01'],
  ] as const)('by quarter, %s starts on a quarter, at %s, within 24 months', (preset, from) => {
    expect(presetRange(preset, 'quarter', TODAY)).toStrictEqual({ from, to: '2026-11', grain: 'quarter' })
  })

  // Review round 1: every preset by every grain on a mid-quarter day of each month stays within the server's bound.
  it.each(Array.from({ length: 12 }, (_, index) => index))('stays within 24 months in month %i', (index) => {
    const today = new Date(Date.UTC(2026, index, 15))
    for (const preset of ['last6', 'last12', 'thisYear', 'last24'] as const) {
      for (const grain of ['month', 'quarter'] as const) {
        const range = presetRange(preset, grain, today)
        const months = monthsCovered(range.from, range.to)
        const quarterAligned = grain === 'month' || (Number(range.from.slice(5)) - 1) % 3 === 0
        expect({ preset, grain, fits: months >= 1 && months <= 24 && quarterAligned })
          .toStrictEqual({ preset, grain, fits: true })
      }
    }
  })
})

describe('periodLabel', () => {
  const quarter = (q: string, year: string) => `Q${q} ${year}`

  it('writes a month in the locale and a quarter through its label', () => {
    expect(periodLabel('2026-11', 'en', quarter)).toBe('Nov 2026')
    expect(periodLabel('2026-Q4', 'en', quarter)).toBe('Q4 2026')
  })

  it('leaves anything else as it is', () => {
    expect(periodLabel('total', 'en', quarter)).toBe('total')
  })
})
