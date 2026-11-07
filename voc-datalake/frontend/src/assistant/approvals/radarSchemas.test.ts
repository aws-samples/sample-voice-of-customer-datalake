/**
 * The Radar approval boundary (./radarSchemas) words its own messages over the stream Lambda's rules
 * (`@stream/assistant/tools/client/radar-schemas`), so it must accept and refuse the same arguments as the
 * stream's own schema: a rule accepted by one side only would mean a card the server proposes but the SPA
 * refuses. The `radar_brand` checks compare ./scraperSchemas with the stream's scraper schemas.
 */
import { describe, it, expect } from 'vitest'
import * as streamRadar from '@stream/assistant/tools/client/radar-schemas'
import * as streamScrapers from '@stream/assistant/tools/client/scraper-schemas'
import { createAppConnectorArgs, createScraperShape } from './scraperSchemas'
import { runRadarScanArgs, saveRadarBrandsArgs } from './radarSchemas'

const L = streamRadar.RADAR_BRAND_LIMITS
const FEEDS = ['https://acme.example/feed', ' https://acme.example/rss ', 'http://acme.example/feed', 'https://u:p@acme.example/f',
  'https://acme.example/f#x', 'https://10.0.0.1/feed', 'https://intranet/feed', 'https://localhost/feed', 'https://acme.example/a b',
  `https://acme.example/${'x'.repeat(500)}`, 'not a url']
const TERMS = ['Acme Air a.s.', '  two   words ', 'say "hi"', '-minus', 'in-between', '', 'x'.repeat(60), 'x'.repeat(61), 'a\u0000b']
const LABELS = ['Acme Air', '  Example Air  ', 'A&B+C', "O'Brien Co.", 'Ünïcode', '__x__', 'a/b', '', '-', 'x'.repeat(64), 'x'.repeat(65)]
const HOSTS = ['acme.example', 'https://www.Acme.example/news', 'localhost', 'intranet', '-bad.example', 'a.b.c.example', 'x.y']

const LISTS = [
  ...LABELS.map((label) => ({ brands: [{ label }] })),
  ...HOSTS.map((host) => ({ brands: [{ label: 'Acme', domains: [host] }] })),
  { brands: [{ label: 'Acme' }, { label: 'ACME' }] },
  ...FEEDS.map((url) => ({ brands: [{ label: 'Acme', feed_urls: [url] }] })),
  { brands: [{ label: 'Acme', feed_urls: FEEDS.slice(0, 1).concat(['https://a.example/1', 'https://a.example/2', 'https://a.example/3']) }] },
  ...['pl', 'cs', null, 'zh', 'PL', ''].map((language) => ({ brands: [{ label: 'Acme', language }] })),
  { brands: Array.from({ length: L.maxBrands + 1 }, (_, i) => ({ label: `B${String(i)}` })) },
  ...TERMS.flatMap((term) => [{ brands: [{ label: 'Acme', search_terms: [term] }] }, { brands: [{ label: 'Acme', exclude_terms: [term] }] }]),
  { brands: [{ label: 'Acme', search_terms: Array.from({ length: L.maxTerms + 1 }, (_, i) => `t${String(i)}`) }] },
  { brands: [{ label: 'Acme', exclude_terms: [...Array.from({ length: L.maxTerms }, (_, i) => `t${String(i)}`), 'T1'] }] },
]

describe('Radar approval boundary ⇄ the stream schemas', () => {
  it('accepts some lists and refuses others (positive control)', () => {
    const outcomes = LISTS.map((args) => saveRadarBrandsArgs.safeParse(args).success)
    expect([outcomes.includes(true), outcomes.includes(false)]).toStrictEqual([true, true])
  })

  it('accepts and refuses the same brand lists, with the same parsed value', () => {
    expect(LISTS.map((args) => saveRadarBrandsArgs.safeParse(args).data))
      .toStrictEqual(LISTS.map((args) => streamRadar.saveRadarBrandsArgsSchema.safeParse(args).data))
  })

  it('accepts and refuses the same scan brand keys', () => {
    const keys = ['acme-air', 'example-air', 'Acme', '-x', 'a_b', '']
    expect(keys.map((brand) => runRadarScanArgs.safeParse({ brand }).success))
      .toStrictEqual(keys.map((brand) => streamRadar.runRadarScanArgsSchema.safeParse({ brand }).success))
  })

  it('radar_brand is an argument of create_scraper and create_app_connector on both sides', () => {
    expect('radar_brand' in createScraperShape.shape).toBe(true)
    expect('radar_brand' in streamScrapers.createScraperArgsSchema.shape).toBe(true)
    const web = { source: 'web_reviews', app_name: 'A', url: 'https://www.trustpilot.com/review/a.example', radar_brand: 'example-air' }
    expect([createAppConnectorArgs.safeParse(web).success, streamScrapers.createAppConnectorArgsSchema.safeParse(web).success]).toStrictEqual([true, true])
  })
})
