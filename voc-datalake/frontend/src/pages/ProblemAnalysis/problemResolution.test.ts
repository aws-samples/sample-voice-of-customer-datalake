/**
 * @fileoverview Tests for problem-resolution key building and tree filtering.
 */
import { describe, it, expect } from 'vitest'
import { applyResolution, buildResolutionKey } from './problemResolution'

describe('buildResolutionKey', () => {
  it('joins category, subcategory, and normalized problem text', () => {
    expect(buildResolutionKey('delivery', 'shipping_speed', 'Slow delivery times'))
      .toBe('delivery|shipping_speed|slow delivery times')
  })

  it('normalizes whitespace and case so cosmetic changes keep the key stable', () => {
    expect(buildResolutionKey('delivery', 'general', '  Slow   DELIVERY  times '))
      .toBe('delivery|general|slow delivery times')
  })
})

const makeProblem = (problem: string, items: number, urgent: number) => ({
  problem,
  items: Array.from({ length: items }, (_, i) => ({ id: i })),
  urgentCount: urgent,
})

const tree = () => ([
  {
    category: 'delivery',
    totalItems: 5,
    urgentCount: 3,
    subcategories: [
      {
        subcategory: 'speed',
        totalItems: 5,
        urgentCount: 3,
        problems: [
          makeProblem('slow delivery', 3, 2),
          makeProblem('lost packages', 2, 1),
        ],
      },
    ],
  },
])

describe('applyResolution', () => {
  const resolvedMap = {
    'delivery|speed|slow delivery': { resolved_at: '2026-07-01T00:00:00Z' },
  }

  it('hides resolved problems and recomputes totals by default', () => {
    const { visible, resolvedCount } = applyResolution(tree(), resolvedMap, false)

    expect(resolvedCount).toBe(1)
    expect(visible[0].subcategories[0].problems.map((p) => p.problem)).toEqual(['lost packages'])
    expect(visible[0].subcategories[0].totalItems).toBe(2)
    expect(visible[0].subcategories[0].urgentCount).toBe(1)
    expect(visible[0].totalItems).toBe(2)
    expect(visible[0].urgentCount).toBe(1)
  })

  it('drops categories whose problems are all resolved', () => {
    const allResolved = {
      'delivery|speed|slow delivery': { resolved_at: '2026-07-01T00:00:00Z' },
      'delivery|speed|lost packages': { resolved_at: '2026-07-01T00:00:00Z' },
    }
    const { visible, resolvedCount } = applyResolution(tree(), allResolved, false)

    expect(visible).toEqual([])
    expect(resolvedCount).toBe(2)
  })

  it('keeps resolved problems annotated when showResolved is on', () => {
    const { visible, resolvedCount } = applyResolution(tree(), resolvedMap, true)

    const problems = visible[0].subcategories[0].problems
    expect(resolvedCount).toBe(1)
    expect(problems).toHaveLength(2)
    expect(problems.find((p) => p.problem === 'slow delivery')?.resolved).toBe(true)
    expect(problems.find((p) => p.problem === 'lost packages')?.resolved).toBe(false)
  })

  it('is a no-op with an empty resolved map', () => {
    const { visible, resolvedCount } = applyResolution(tree(), {}, false)

    expect(resolvedCount).toBe(0)
    expect(visible[0].subcategories[0].problems).toHaveLength(2)
  })
})
