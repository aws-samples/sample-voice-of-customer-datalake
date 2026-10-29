/**
 * The "All brands" wire shape (GET /radar/all): lenient like every Radar read — a missing or
 * malformed latest release is null, bad numbers read 0, unknown fields are dropped, and a release
 * without a brand costs itself.
 */
import { describe, expect, it } from 'vitest'
import { normalizeRadarAll } from './radarSchema'

const RELEASE = {
  release_id: 'r1', feature: 'Dark mode', release_date: '2026-09-01', summary: '', urls: ['https://acme.example/n'],
  titles: ['News'], source_kind: 'official', mentions: 2,
}
const PARSED_RELEASE = { ...RELEASE, date_approximate: false, kind: 'release', found_via: ['web'] }
const NO_NEWS_FIELDS = { language: null, effective_language: 'en', feed_urls: [], search_terms: [], exclude_terms: [] }

describe('normalizeRadarAll', () => {
  it('reads every brand with its totals and its latest release, and the brand-tagged feed', () => {
    const all = normalizeRadarAll({
      days: 90, releases_total: 1, releases_capped: false, extra: 'ignored',
      brands: [{ key: 'acme', label: 'Acme', domains: ['acme.example'], origin: 'list', sources: [], total: 5, avg_sentiment: 0.4,
        sentiment: { positive: 3, negative: 1, neutral: 1, mixed: 0 }, releases_in_window: 1, latest_release: RELEASE, unknown: true }],
      releases: [{ ...RELEASE, brand: { key: 'acme', label: 'Acme' } }],
    })
    expect(all).toStrictEqual({
      days: 90, releases_total: 1, releases_capped: false,
      brands: [{ key: 'acme', label: 'Acme', domains: ['acme.example'], origin: 'list', sources: [], total: 5, avg_sentiment: 0.4, ...NO_NEWS_FIELDS,
        sentiment: { positive: 3, negative: 1, neutral: 1, mixed: 0 }, releases_in_window: 1, latest_release: PARSED_RELEASE }],
      releases: [{ ...PARSED_RELEASE, brand: { key: 'acme', label: 'Acme' } }],
    })
  })

  it('reads a missing latest release as null and bad numbers as 0', () => {
    const [acme] = normalizeRadarAll({ brands: [{ key: 'acme', total: -3, releases_in_window: 'x' }] }).brands
    expect(acme).toMatchObject({ label: 'acme', total: 0, releases_in_window: 0, latest_release: null, avg_sentiment: null, origin: 'list' })
    expect(normalizeRadarAll({ brands: [{ key: 'acme', latest_release: { feature: '' } }] }).brands[0]?.latest_release).toBeNull()
  })

  it('drops a feed release without a brand and labels a brand without one by its key', () => {
    const all = normalizeRadarAll({ releases: [RELEASE, { ...RELEASE, brand: { key: 'globex', label: '' } }], releases_total: 'many' })
    expect(all.releases.map((r) => r.brand)).toStrictEqual([{ key: 'globex', label: 'globex' }])
    expect(all.releases_total).toBe(0)
    expect(all.releases_capped).toBe(false)
  })

  it('reads an unusable answer as nothing tracked', () => {
    expect(normalizeRadarAll(null)).toStrictEqual({ days: 0, brands: [], releases: [], releases_total: 0, releases_capped: false })
  })
})
