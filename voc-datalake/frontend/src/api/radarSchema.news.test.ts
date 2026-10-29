/**
 * Radar's news wire fields, read leniently like every Radar read: a brand's `language` (null =
 * auto, anything off the list too), `effective_language` (English by default) and `feed_urls`
 * (https only, at most 3); a news item's `kind` (missing = release, unknown = company news) and
 * `found_via` (unknown dropped, none = web); the settings' `exa_configured`; an old shape reads
 * as before.
 */
import { describe, expect, it } from 'vitest'
import { normalizeExaKeyAnswer, normalizeRadarAll, normalizeRadarBrands, normalizeRadarOverview, normalizeRadarPage } from './radarSchema'

const RELEASE = { release_id: 'r1', feature: 'Dark mode', release_date: '2026-09-01' }
const brandWith = (fields: Record<string, unknown>) => normalizeRadarBrands({ brands: [{ key: 'acme', label: 'Acme', ...fields }] })[0]
const releaseWith = (fields: Record<string, unknown>) => normalizeRadarPage({ releases: { releases: [{ ...RELEASE, ...fields }] } }).releases[0]

describe('a Radar brand\'s language and news feeds', () => {
  it('reads them as sent', () => {
    expect(brandWith({ language: 'pl', effective_language: 'pl', feed_urls: ['https://example.pl/feed.xml'] })).toMatchObject({
      language: 'pl', effective_language: 'pl', feed_urls: ['https://example.pl/feed.xml'],
    })
  })

  it('reads an older brand as auto, English, no feed', () => {
    expect(brandWith({})).toMatchObject({ language: null, effective_language: 'en', feed_urls: [] })
  })

  it('reads a language off the list as auto, and an unusable effective one as English', () => {
    expect(brandWith({ language: 'xx', effective_language: 42 })).toMatchObject({ language: null, effective_language: 'en' })
    expect(brandWith({ language: 'PL' })?.language).toBeNull()
  })

  it('keeps https feeds only, at most 3', () => {
    const feeds = ['http://example.com/a', 'https://example.pl/b', 7, 'https://', 'https://example.pl/c', 'https://example.pl/d', 'https://example.pl/e']
    expect(brandWith({ feed_urls: feeds })?.feed_urls).toStrictEqual(['https://example.pl/b', 'https://example.pl/c', 'https://example.pl/d'])
    expect(brandWith({ feed_urls: 'https://example.pl/b' })?.feed_urls).toStrictEqual([])
  })

  it('reads them on every brand shape (overview, All brands)', () => {
    const raw = { key: 'acme', language: 'cs', effective_language: 'cs', feed_urls: ['https://example.cz/f'] }
    const expected = { language: 'cs', effective_language: 'cs', feed_urls: ['https://example.cz/f'] }
    expect(normalizeRadarOverview({ brands: [raw] }).brands[0]).toMatchObject(expected)
    expect(normalizeRadarAll({ brands: [raw] }).brands[0]).toMatchObject(expected)
  })
})

describe('a Radar news item\'s kind and how it was found', () => {
  it('reads each known kind and source', () => {
    expect(releaseWith({ kind: 'partnership', found_via: ['feed', 'exa'] })).toMatchObject({ kind: 'partnership', found_via: ['feed', 'exa'] })
  })

  it('reads an older item as a release found by web search', () => {
    expect(releaseWith({})).toMatchObject({ kind: 'release', found_via: ['web'] })
    expect(releaseWith({ kind: null, found_via: [] })).toMatchObject({ kind: 'release', found_via: ['web'] })
  })

  it('reads an unknown kind as company news and drops unknown or repeated sources', () => {
    expect(releaseWith({ kind: 'rumour', found_via: ['exa', 'carrier-pigeon', 'exa'] })).toMatchObject({ kind: 'news', found_via: ['exa'] })
    expect(releaseWith({ found_via: ['carrier-pigeon'] })?.found_via).toStrictEqual(['web'])
  })

  it('reads them in the All brands feed and a brand\'s latest item', () => {
    const item = { ...RELEASE, kind: 'promotion', found_via: ['exa'], brand: { key: 'acme', label: 'Acme' } }
    const all = normalizeRadarAll({ releases: [item], brands: [{ key: 'acme', latest_release: item }] })
    expect(all.releases[0]).toMatchObject({ kind: 'promotion', found_via: ['exa'] })
    expect(all.brands[0]?.latest_release).toMatchObject({ kind: 'promotion', found_via: ['exa'] })
  })
})

describe('the Exa key status', () => {
  it('reads exa_configured on the settings, false when absent or malformed', () => {
    expect(normalizeRadarOverview({ settings: { exa_configured: true } }).settings.exa_configured).toBe(true)
    expect(normalizeRadarOverview({ settings: { cadence: 'daily' } }).settings).toMatchObject({ cadence: 'daily', exa_configured: false })
    expect(normalizeRadarOverview({ settings: { exa_configured: 'yes' } }).settings.exa_configured).toBe(false)
  })

  it('reads the key routes\' answer, never anything but the flag', () => {
    expect(normalizeExaKeyAnswer({ success: true, exa_configured: true, api_key: 'leak' })).toBe(true)
    expect(normalizeExaKeyAnswer({ success: true, exa_configured: false })).toBe(false)
    expect(normalizeExaKeyAnswer(null)).toBe(false)
  })
})
