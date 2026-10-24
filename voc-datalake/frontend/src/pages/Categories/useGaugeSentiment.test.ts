import { describe, expect, it } from 'vitest'
import { gaugeScopeCategory, toSentimentData } from './useGaugeSentiment'

describe('gaugeScopeCategory', () => {
  it('scopes to exactly one selected category', () => {
    expect(gaugeScopeCategory(['technical_support'])).toBe('technical_support')
  })

  it('keeps the window sentiment for none or several', () => {
    expect(gaugeScopeCategory([])).toBeNull()
    expect(gaugeScopeCategory(['a', 'b'])).toBeNull()
    expect(gaugeScopeCategory(undefined)).toBeNull()
  })
})

describe('toSentimentData', () => {
  it('maps each reported label to a slice with its percentage', () => {
    const data = toSentimentData({ period_days: 7, total: 4, breakdown: { negative: 3, positive: 1 }, percentages: { negative: 75 } })
    expect(data.map((d) => [d.name, d.value, d.percentage])).toStrictEqual([['negative', 3, 75], ['positive', 1, 0]])
    expect(toSentimentData(undefined)).toStrictEqual([])
  })
})
