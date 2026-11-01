/**
 * The brand view's groupings: themes by top-level category (biggest first, at most two quotes a
 * theme, no quote twice in a column), the trend over every day of the window, releases by month.
 */
import { describe, expect, it } from 'vitest'
import { fillWindow, groupByMonth, groupThemes } from './radarGroups'

const theme = (category: string, subcategory: string | null, count: number, quotes: string[] = []) => ({ category, subcategory, count, quotes })

describe('groupThemes', () => {
  it('groups by category with its total, biggest category and biggest theme first', () => {
    const groups = groupThemes([
      theme('pricing', null, 3),
      theme('delivery', 'speed', 4),
      theme('delivery', 'tracking', 6),
    ])
    expect(groups.map((g) => [g.category, g.total])).toStrictEqual([['delivery', 10], ['pricing', 3]])
    expect(groups[0]?.themes.map((t) => t.theme.subcategory)).toStrictEqual(['tracking', 'speed'])
  })

  it('shows at most two quotes a theme', () => {
    const [group] = groupThemes([theme('delivery', 'speed', 4, ['One', 'Two', 'Three'])])
    expect(group?.themes[0]?.quotes).toStrictEqual(['One', 'Two'])
  })

  it('says a quote once per column, whatever its case or spacing', () => {
    const groups = groupThemes([
      theme('delivery', 'speed', 8, ['Arrived early.', 'Fast.']),
      theme('delivery', 'tracking', 4, [' arrived early. ', 'Live map.']),
      theme('support', null, 2, ['Fast.', '']),
    ])
    expect(groups.flatMap((g) => g.themes.map((t) => t.quotes))).toStrictEqual([['Arrived early.', 'Fast.'], ['Live map.'], []])
  })

  it('answers no group for no theme', () => {
    expect(groupThemes([])).toStrictEqual([])
  })
})

describe('fillWindow', () => {
  const NOW = new Date('2026-11-01T08:00:00Z')

  it('fills every day of the window, ending today, a missing day 0 reviews and no sentiment', () => {
    const filled = fillWindow([{ date: '2026-10-30', count: 3, avg_sentiment: 0.4 }], 7, NOW)
    expect(filled.map((p) => p.date)).toStrictEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(filled[4]).toStrictEqual({ date: '2026-10-30', count: 3, avg_sentiment: 0.4 })
    expect(filled[0]).toStrictEqual({ date: '2026-10-26', count: 0, avg_sentiment: null })
  })

  it('keeps a day outside the window rather than hiding its reviews', () => {
    const filled = fillWindow([{ date: '2026-11-02', count: 1, avg_sentiment: 0 }], 2, NOW)
    expect(filled.map((p) => p.date)).toStrictEqual(['2026-10-31', '2026-11-01', '2026-11-02'])
  })
})

describe('groupByMonth', () => {
  it('groups by month in the order given', () => {
    const groups = groupByMonth([{ release_date: '2026-10-20' }, { release_date: '2026-10-02' }, { release_date: '2026-09-30' }])
    expect(groups.map((g) => [g.month, g.items.length])).toStrictEqual([['2026-10', 2], ['2026-09', 1]])
  })
})
