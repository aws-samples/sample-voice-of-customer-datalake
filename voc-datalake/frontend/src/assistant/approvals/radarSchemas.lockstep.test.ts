/**
 * LOCKSTEP: the Radar write boundary (./radarSchemas, and `radar_brand` in
 * ./scraperSchemas) ⇄ the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/radar-schemas.ts`,
 * `scraper-schemas.ts`) ⇄ `lambda/shared/radar_brands.py`. Constants are read as
 * TEXT; the behaviour is compared through a direct import of the stream module
 * on the same inputs. A rule accepted by one side only would mean a card the
 * server proposes but the SPA refuses, or a save the route rejects after approval.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RADAR_BRAND_KEY_RULE, createAppConnectorArgs, createScraperShape } from './scraperSchemas'
import { SPA_RADAR_LIMITS, brandHostOf, brandKeyOf, runRadarScanArgs, saveRadarBrandsArgs } from './radarSchemas'
import { constNumberRecord } from '@test/sourceLiterals'
// Self-contained (zod only, same major), like the scraper lockstep's direct import.
import * as streamRadar from '../../../../lambda/stream/src/assistant/tools/client/radar-schemas'
import * as streamScrapers from '../../../../lambda/stream/src/assistant/tools/client/scraper-schemas'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const stream = read('lambda/stream/src/assistant/tools/client/radar-schemas.ts')
const python = read('lambda/shared/radar_brands.py')
const pythonFinal = (name: string) => Number(new RegExp(`^${name}: Final = (\\d+)$`, 'm').exec(python)?.[1])

const LABELS = ['Acme Air', '  Example Air  ', 'A&B+C', "O'Brien Co.", 'Ünïcode', '__x__', 'a/b', '', '-', 'x'.repeat(64), 'x'.repeat(65)]
const HOSTS = ['acme.example', 'https://www.Acme.example/news', 'localhost', 'intranet', '-bad.example', 'a.b.c.example', 'x.y']

describe('Radar brand rules: stream ⇄ SPA ⇄ radar_brands.py', () => {
  it('the same limits, and the label / domain caps are the Python ones', () => {
    expect(constNumberRecord(stream, 'RADAR_BRAND_LIMITS')).toStrictEqual({ ...SPA_RADAR_LIMITS })
    expect([pythonFinal('MAX_BRAND_CHARS'), pythonFinal('MAX_BRAND_DOMAINS')]).toStrictEqual([SPA_RADAR_LIMITS.maxLabelChars, SPA_RADAR_LIMITS.maxDomains])
  })

  it('the same brand key and domain normalisation on both sides', () => {
    expect(LABELS.map(brandKeyOf)).toStrictEqual(LABELS.map(streamRadar.radarBrandKey))
    expect(HOSTS.map(brandHostOf)).toStrictEqual(HOSTS.map(streamRadar.normalizedBrandDomain))
  })

  it('accepts and refuses the same brand lists', () => {
    const lists = [
      ...LABELS.map((label) => ({ brands: [{ label }] })),
      ...HOSTS.map((host) => ({ brands: [{ label: 'Acme', domains: [host] }] })),
      { brands: [{ label: 'Acme' }, { label: 'ACME' }] },
      { brands: Array.from({ length: SPA_RADAR_LIMITS.maxBrands + 1 }, (_, i) => ({ label: `B${String(i)}` })) },
    ]
    expect(lists.map((args) => saveRadarBrandsArgs.safeParse(args).success))
      .toStrictEqual(lists.map((args) => streamRadar.saveRadarBrandsArgsSchema.safeParse(args).success))
  })

  it('the same brand-key slug on scrapers, connectors and the scan', () => {
    expect(read('lambda/stream/src/assistant/tools/client/scraper-schemas.ts')).toContain(`const RADAR_BRAND_KEY_PATTERN = ${String(RADAR_BRAND_KEY_RULE)};`)
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
