import { describe, expect, it } from 'vitest'
import defaultSetup from '../../../schemas/prioritization-default-axes.json'
import {
  DEFAULT_AXES, activeAxes, axesByWeight, compositeScore, configVersionOf, normalizeAxes, weightShares,
} from './prioritizationAxes'
import type { ScoringAxis } from './prioritizationAxes'

const axis = (id: string, weight: number, extra: Partial<ScoringAxis> = {}): ScoringAxis => ({
  id, builtin: false, label: id, description: null, weight, direction: 'higher_better',
  low_label: null, high_label: null, archived: false, ...extra,
})

describe('DEFAULT_AXES (the shared JSON fixture)', () => {
  it('is the four built-ins with the historical weights, in the configured order', () => {
    expect(DEFAULT_AXES.map((a) => [a.id, a.weight, a.builtin])).toStrictEqual([
      ['impact', 40, true], ['time_to_market', 30, true], ['strategic_fit', 20, true], ['confidence', 10, true],
    ])
  })

  it('reads every entry of the JSON (nothing dropped by the boundary)', () => {
    expect(DEFAULT_AXES).toHaveLength(defaultSetup.axes.length)
  })
})

describe('compositeScore — THE CONTRACT formula', () => {
  it('reproduces the old 0.4/0.3/0.2/0.1 weighting on a fully scored default ballot', () => {
    const values = { impact: 5, time_to_market: 3, strategic_fit: 4, confidence: 2 }
    expect(compositeScore(DEFAULT_AXES, values)).toBeCloseTo((5 * 0.4) + (3 * 0.3) + (4 * 0.2) + (2 * 0.1))
  })

  it('leaves an unscored axis out of both sums (impact 4 alone reads 4)', () => {
    expect(compositeScore(DEFAULT_AXES, { impact: 4, time_to_market: 0 })).toBe(4)
  })

  it('inverts a lower_better axis as 6 − v', () => {
    const axes = [axis('value', 60), axis('effort', 40, { direction: 'lower_better' })]
    // effort 5 (worst) counts as 1: (60·4 + 40·1) / 100
    expect(compositeScore(axes, { value: 4, effort: 5 })).toBeCloseTo(2.8)
  })

  it('ignores archived axes and answers null when nothing weighted was scored', () => {
    const axes = [axis('a', 50, { archived: true }), axis('b', 0)]
    expect([compositeScore(axes, { a: 5, b: 3 }), compositeScore(axes, {})]).toStrictEqual([null, null])
  })
})

describe('normalizeAxes', () => {
  it('answers the default when the field is absent or not a list', () => {
    expect([normalizeAxes(undefined), normalizeAxes({})]).toStrictEqual([DEFAULT_AXES, DEFAULT_AXES])
  })

  it('drops axes with an unreadable id, unnamed custom axes and duplicates', () => {
    const parsed = normalizeAxes([
      { id: 'reach', label: 'Reach', weight: 30 },
      { id: 'Bad Id', label: 'x', weight: 10 },
      { id: 'nameless', label: '  ', weight: 10 },
      { id: 'reach', label: 'Again', weight: 1 },
    ])
    expect(parsed.map((a) => a.id)).toStrictEqual(['reach'])
  })

  it('clamps weights, defaults direction and marks built-ins by id', () => {
    const [first] = normalizeAxes([{ id: 'impact', weight: 400, direction: 'sideways', label: null }])
    expect(first).toMatchObject({ weight: 100, direction: 'higher_better', builtin: true, label: null })
  })

  it('falls back to the default when no axis is active', () => {
    expect(normalizeAxes([{ id: 'reach', label: 'Reach', weight: 1, archived: true }])).toBe(DEFAULT_AXES)
  })
})

describe('weight helpers', () => {
  const axes = [axis('a', 30), axis('b', 10), axis('c', 30), axis('gone', 90, { archived: true })]

  it('shares are percentages of the active weights', () => {
    expect(weightShares(axes)).toStrictEqual({ a: 43, b: 14, c: 43 })
  })

  it('orders active axes by weight, ties keeping the configured order', () => {
    expect(axesByWeight(axes).map((a) => a.id)).toStrictEqual(['a', 'c', 'b'])
  })

  it('activeAxes drops archived ones', () => {
    expect(activeAxes(axes)).toHaveLength(3)
  })

  it('configVersionOf reads a non-negative int, else 0', () => {
    expect([configVersionOf(3), configVersionOf('3'), configVersionOf(-1)]).toStrictEqual([3, 0, 0])
  })
})
