import { describe, expect, it } from 'vitest'
import { categoryLabel, sourceLabel } from '../../utils/displayLabels'
import { feedbackItem } from '../Categories/categories-fixtures'
import { activeSourceCount, buildPDFExportData, prepareSourceData, sourceChartRows, trendSeries } from './dashboardData'

const labels = { category: (id: string) => categoryLabel(id), source: (id: string) => sourceLabel(id) }

describe('dashboardData labels', () => {
  it('labels every source bar, not just the first underscore', () => {
    const sources = { period_days: 7, sources: { 'Acme Android_android': 3, web_trustpilot_acme_airlines: 2 } }
    expect(prepareSourceData(sources, labels.source).map((row) => row.name))
      .toStrictEqual(['Acme (Android)', 'Acme airlines (Trustpilot)'])
  })

  it('draws the eight largest sources and folds the rest into one "Other" bar', () => {
    const sources = { period_days: 7, sources: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src_${i}`, i + 1])) }
    const rows = sourceChartRows(sources, labels.source, (n) => `Other (${n})`)
    expect([rows.length, rows[0], rows.at(-1)]).toStrictEqual([9, { id: 'src_10', name: 'Src 10', value: 11 }, { id: null, name: 'Other (3)', value: 6 }])
  })

  it('keeps nine sources as nine bars (an "Other" of one would hide a name for nothing)', () => {
    const sources = { period_days: 7, sources: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`src_${i}`, 1])) }
    expect(sourceChartRows(sources, labels.source, () => 'Other').map((row) => row.name)).not.toContain('Other')
  })

  it('prints labelled categories and urgent items in the PDF export', () => {
    const data = buildPDFExportData({
      summary: undefined, sentiment: undefined, sources: undefined, timeRange: '7d', sourcesCount: 1, labels,
      categories: { period_days: 7, categories: { ease_of_use: 4 } },
      urgentFeedback: { items: [feedbackItem({ source_platform: 'AcmeAir_ios', category: 'software_firmware' })] },
    })
    expect(data.categoryBreakdown).toStrictEqual([{ name: 'Ease of use', value: 4 }])
    expect(data.urgentItems.map((item) => `${item.source_platform} • ${item.category}`)).toStrictEqual(['AcmeAir (iOS) • Software firmware'])
  })
})

describe('trendSeries (the trend draws reviews per day and the day\'s average sentiment)', () => {
  it('fills every missing day with 0 reviews and no average, oldest first', () => {
    const series = trendSeries({
      daily_totals: [{ date: '2026-10-04', count: 3 }, { date: '2026-10-01', count: 5 }],
      daily_sentiment: [{ date: '2026-10-01', avg_sentiment: -0.4, count: 5 }],
    })
    expect(series).toStrictEqual([
      { date: '2026-10-01', reviews: 5, sentiment: -0.4 },
      { date: '2026-10-02', reviews: 0, sentiment: null },
      { date: '2026-10-03', reviews: 0, sentiment: null },
      { date: '2026-10-04', reviews: 3, sentiment: null },
    ])
  })

  it('is empty without data, and keeps only the known days across a very long span', () => {
    expect(trendSeries(undefined)).toStrictEqual([])
    const long = trendSeries({ daily_totals: [{ date: '2020-01-01', count: 1 }, { date: '2026-01-01', count: 2 }], daily_sentiment: [] })
    expect(long.map((d) => d.date)).toStrictEqual(['2020-01-01', '2026-01-01'])
  })
})

describe('activeSourceCount', () => {
  it('counts only sources that brought a review in the window', () => {
    expect(activeSourceCount({ period_days: 7, sources: { a: 4, b: 0, c: 1 } })).toBe(2)
    expect(activeSourceCount(undefined)).toBe(0)
  })
})
