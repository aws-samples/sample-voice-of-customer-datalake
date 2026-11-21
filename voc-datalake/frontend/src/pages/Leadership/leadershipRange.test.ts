/** The leadership view's ranges and period labels (leadershipRange.ts). */
import { describe, expect, it } from 'vitest'
import { periodLabel, presetRange } from './leadershipRange'

const TODAY = new Date(Date.UTC(2026, 10, 21))

describe('presetRange', () => {
  it.each([
    ['last6', '2026-06'], ['last12', '2025-12'], ['thisYear', '2026-01'], ['last24', '2024-12'],
  ] as const)('%s starts at %s and ends with the current month', (preset, from) => {
    expect(presetRange(preset, 'quarter', TODAY)).toStrictEqual({ from, to: '2026-11', grain: 'quarter' })
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
