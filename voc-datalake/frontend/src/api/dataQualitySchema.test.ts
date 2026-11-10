import { describe, expect, it } from 'vitest'
import { normalizeDataQuality } from './dataQualitySchema'
import { emptyProfile } from './dataQualityProfileSchema'

const row = (source: string, counts: Partial<Record<'high' | 'medium' | 'low' | 'unrated' | 'total', unknown>>) =>
  ({ source, high: 0, medium: 0, low: 0, unrated: 0, total: 0, ...counts })

describe('normalizeDataQuality', () => {
  it('keeps the API order and re-sums the overall row from the kept sources', () => {
    const result = normalizeDataQuality({
      is_partial: true,
      sources: [row('web', { high: 3, low: 1, unrated: 2, total: 6 }), row('app', { medium: 2, total: 2 })],
      overall: { high: 999 },
    })
    expect(result.isPartial).toBe(true)
    expect(result.sources.map((s) => s.source)).toStrictEqual(['web', 'app'])
    expect(result.overall).toStrictEqual({ high: 3, medium: 2, low: 1, unrated: 2, total: 8, profile: emptyProfile() })
  })

  it('drops malformed and empty rows and reads a bad count as 0', () => {
    const result = normalizeDataQuality({
      sources: [row('', { high: 1, total: 1 }), 'junk', row('empty', {}), row('web', { high: 'x', low: -4, unrated: '2', total: 2 })],
    })
    expect(result.sources).toStrictEqual([{ ...row('web', { unrated: 2, total: 2 }), profile: emptyProfile() }])
  })

  it('never answers a total below the bands it holds', () => {
    const [web] = normalizeDataQuality({ sources: [row('web', { high: 5, total: 1 })] }).sources
    expect(web?.total).toBe(5)
  })

  it.each([null, 'nope', { sources: 'x' }])('treats %j as no data', (raw) => {
    expect(normalizeDataQuality(raw)).toStrictEqual({
      isPartial: false, sources: [], overall: { high: 0, medium: 0, low: 0, unrated: 0, total: 0, profile: emptyProfile() },
    })
  })
})
