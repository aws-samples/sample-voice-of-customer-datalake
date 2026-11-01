/**
 * LOCKSTEP: the connector approval boundary (./scraperSchemas) ⇄ the stream
 * Lambda's (`lambda/stream/src/assistant/tools/client/scraper-schemas.ts`) ⇄
 * the routes that store the configs (`lambda/api/scrapers_handler.py`, its id rule in `lambda/shared/row_ids.py`,
 * `integrations_handler.py`) and the app-review manifests. Constants are read as
 * TEXT (so un-exported ones count too); the argument shapes are compared through
 * a direct import of the stream module. A bound accepted by
 * one side only would mean a card the server proposes but the SPA refuses —
 * or a save the route rejects after the user approved it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  APP_FREQUENCIES, APP_SOURCES, SCRAPER_ID_RULE, SCRAPER_METHODS, SELECTOR_KEYS, SORT_ORDERS_BY_SOURCE, SPA_APP_DEFAULTS,
  SPA_APP_LIMITS, SPA_SCRAPER_LIMITS, SPA_WEB_PAGES, SPA_WEB_REVIEWS, createAppConnectorArgs, createScraperShape, updateScraperArgs,
} from './scraperSchemas'
import { at } from '@test/defined'
import { constNumberRecord, constStringList } from '@test/sourceLiterals'
// Self-contained (zod only, same major), like the contract lockstep's direct import.
import * as streamSchemas from '../../../../lambda/stream/src/assistant/tools/client/scraper-schemas'

const ROOT = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const stream = read('lambda/stream/src/assistant/tools/client/scraper-schemas.ts')
const handler = read('lambda/api/scrapers_handler.py')
// The list bounds both scraper routes share (POST /scrapers, PUT /integrations/webscraper/credentials).
const scraperLimits = read('lambda/shared/scraper_limits.py')
const rowIds = read('lambda/shared/row_ids.py')
const integrations = read('lambda/api/integrations_handler.py')

const streamList = (name: string) => constStringList(stream, name)
const streamNumbers = (name: string) => constNumberRecord(stream, name)

/**
 * `NAME = <int expression>` (or `NAME: Final = …`) in scrapers_handler.py or shared/scraper_limits.py,
 * evaluated (`8 * 1024`, `30 * 24 * 60`, `10_000`).
 */
function pythonInt(name: string): number {
  const pattern = new RegExp(`^${name}(?:: Final)? = ([\\d_ *]+)$`, 'm')
  const match = pattern.exec(handler) ?? pattern.exec(scraperLimits)
  if (match === null) throw new Error(`${name} not found in scrapers_handler.py or shared/scraper_limits.py`)
  return at(match, 1).split('*').map((part) => Number(part.trim().replaceAll('_', ''))).reduce((a, b) => a * b, 1)
}

const manifestSchema = z.object({
  config: z.array(z.object({ key: z.string(), options: z.array(z.object({ value: z.string() })).optional() })),
})
const manifest = (id: string) => manifestSchema.parse(JSON.parse(read(`plugins/${id}/manifest.json`)))
const options = (id: string, key: string) => manifest(id).config.find((field) => field.key === key)?.options?.map((o) => o.value) ?? []
const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

describe('scraper bounds: stream ⇄ SPA ⇄ scrapers_handler.py', () => {
  it('the stream and the SPA carry the same limits', () => {
    expect(streamNumbers('SCRAPER_LIMITS')).toStrictEqual({ ...SPA_SCRAPER_LIMITS })
  })

  it('the limits are the route\u2019s', () => {
    expect(SPA_SCRAPER_LIMITS).toStrictEqual({
      maxUrls: pythonInt('MAX_URLS_PER_SCRAPER'),
      maxUrlLength: pythonInt('MAX_URL_LENGTH'),
      maxTextField: pythonInt('MAX_TEXT_FIELD_LENGTH'),
      maxPaginationParam: pythonInt('MAX_PAGINATION_PARAM_LENGTH'),
      maxPages: pythonInt('MAX_PAGINATION_PAGES'),
      maxPaginationStart: pythonInt('MAX_PAGINATION_START'),
      maxFrequencyMinutes: pythonInt('MAX_FREQUENCY_MINUTES'),
      maxScraperBytes: pythonInt('MAX_SCRAPER_BYTES'),
    })
  })

  it('the same id pattern on all three sides', () => {
    // JavaScript's `$` is Python's `\Z` (end of input); Python's `$` would also accept a trailing newline.
    // The route validates ids with shared.row_ids.OPAQUE_ID_RE.
    expect(handler).toContain('from shared.row_ids import OPAQUE_ID_RE')
    expect(handler).toContain('OPAQUE_ID_RE.fullmatch(scraper_id)')
    const python = /OPAQUE_ID_RE: Final = re\.compile\(r'([^']+)'\)/.exec(rowIds)
    expect(at(python ?? [], 1)).toBe(SCRAPER_ID_RULE.source.replace(/\$$/, String.raw`\Z`))
    expect(stream).toContain(`SCRAPER_ID_PATTERN = /${SCRAPER_ID_RULE.source}/;`)
  })

  it('the same methods and selector fields (the route\u2019s TEXT_FIELDS minus name and template)', () => {
    expect(streamList('EXTRACTION_METHODS')).toStrictEqual([...SCRAPER_METHODS])
    expect(/EXTRACTION_METHODS = \('css', 'jsonld'\)/.test(handler)).toBe(true)
    expect(streamList('SCRAPER_SELECTOR_FIELDS')).toStrictEqual([...SELECTOR_KEYS])
    const textFields = [.../TEXT_FIELDS = \(([^)]*)\)/.exec(handler)?.[1]?.matchAll(/'([^']+)'/g) ?? []].map((m) => at(m, 1))
    expect(sorted(textFields.filter((f) => f !== 'name' && f !== 'template'))).toStrictEqual(sorted(SELECTOR_KEYS))
  })

  it('the create and update shapes take exactly the stream\u2019s argument fields', () => {
    expect(sorted(Object.keys(createScraperShape.shape))).toStrictEqual(sorted(Object.keys(streamSchemas.createScraperArgsSchema.shape)))
    expect(sorted(Object.keys(updateScraperArgs.shape.updates.shape)))
      .toStrictEqual(sorted(Object.keys(streamSchemas.updateScraperArgsSchema.shape.updates.shape)))
    expect(updateScraperArgs.safeParse({ scraper_id: 's', updates: { id: 'x' } }).success).toBe(false)
  })
})

describe('app connector bounds: stream ⇄ SPA ⇄ integrations_handler.py ⇄ manifests', () => {
  it('the same sources, and they are the route\u2019s APP_CONFIG_PLUGINS', () => {
    expect(streamList('APP_CONNECTOR_SOURCES')).toStrictEqual([...APP_SOURCES])
    const plugins = /APP_CONFIG_PLUGINS = \{([^}]*)\}/.exec(integrations)?.[1] ?? ''
    expect(sorted([...plugins.matchAll(/'([^']+)'/g)].map((m) => at(m, 1)))).toStrictEqual(sorted(APP_SOURCES))
  })

  it('the same sort orders per store, as the manifests list them', () => {
    expect(streamList('IOS_SORT_ORDERS')).toStrictEqual([...SORT_ORDERS_BY_SOURCE.app_reviews_ios])
    expect(streamList('ANDROID_SORT_ORDERS')).toStrictEqual([...SORT_ORDERS_BY_SOURCE.app_reviews_android])
    expect(options('app_reviews_ios', 'sort_by')).toStrictEqual([...SORT_ORDERS_BY_SOURCE.app_reviews_ios])
    expect(options('app_reviews_android', 'sort_by')).toStrictEqual([...SORT_ORDERS_BY_SOURCE.app_reviews_android])
  })

  it('the same frequencies, as both manifests offer them', () => {
    const streamFrequencies = /APP_FREQUENCY_MINUTES = \[([^\]]*)\]/.exec(stream)?.[1]?.split(',').map((n) => Number(n.trim()))
    expect(streamFrequencies).toStrictEqual([...APP_FREQUENCIES])
    expect(options('app_reviews_ios', 'frequency_minutes').map(Number)).toStrictEqual([...APP_FREQUENCIES])
    expect(options('app_reviews_android', 'frequency_minutes').map(Number)).toStrictEqual([...APP_FREQUENCIES])
  })

  it('the same limits and defaults', () => {
    expect(streamNumbers('APP_CONNECTOR_LIMITS')).toStrictEqual({ ...SPA_APP_LIMITS })
    expect(streamNumbers('APP_CONNECTOR_DEFAULTS')).toStrictEqual({ ...SPA_APP_DEFAULTS })
    expect(createAppConnectorArgs.safeParse({ source: 'app_reviews_ios', app_name: 'A', app_id: '1', max_reviews_per_run: SPA_APP_LIMITS.maxReviewsPerRun + 1 }).success).toBe(false)
  })

  const targetsPy = read('lambda/shared/web_review_targets.py')
  const pythonTargets = (name: string) => Number(new RegExp(`^${name}: Final = (\\d+)$`, 'm').exec(targetsPy)?.[1])

  it('the same web_reviews page bounds as web_review_targets.py, and the manifest\u2019s frequencies', () => {
    expect(streamNumbers('WEB_REVIEW_PAGES')).toStrictEqual({ ...SPA_WEB_PAGES })
    expect({ min: pythonTargets('MIN_PAGES'), max: pythonTargets('MAX_PAGES'), default: pythonTargets('DEFAULT_PAGES') }).toStrictEqual({ ...SPA_WEB_PAGES })
    expect(options('web_reviews', 'frequency_minutes').map(Number)).toStrictEqual([...APP_FREQUENCIES])
  })

  it('the same web_reviews review-limit bounds as web_review_targets.py', () => {
    expect(streamNumbers('WEB_REVIEW_REVIEWS')).toStrictEqual({ ...SPA_WEB_REVIEWS })
    expect({ min: pythonTargets('MIN_REVIEWS'), max: pythonTargets('MAX_REVIEWS'), default: pythonTargets('DEFAULT_REVIEWS') }).toStrictEqual({ ...SPA_WEB_REVIEWS })
  })

  const web = { source: 'web_reviews', app_name: 'Acme', url: 'https://www.trustpilot.com/review/acme.example' }

  it('a web_reviews target takes a url and pages, never an app field', () => {
    expect(createAppConnectorArgs.safeParse({ ...web, max_pages: SPA_WEB_PAGES.max }).success).toBe(true)
    expect(createAppConnectorArgs.safeParse({ ...web, max_pages: SPA_WEB_PAGES.max + 1 }).success).toBe(false)
    expect(createAppConnectorArgs.safeParse({ ...web, app_id: '1' }).success).toBe(false)
    expect(streamSchemas.createAppConnectorArgsSchema.safeParse({ ...web, app_id: '1' }).success).toBe(false)
  })

  it('a web_reviews target takes a review limit up to the bound; an app does not', () => {
    expect(createAppConnectorArgs.safeParse({ ...web, max_pages: 0, max_reviews: SPA_WEB_REVIEWS.max }).success).toBe(true)
    expect(createAppConnectorArgs.safeParse({ ...web, max_reviews: SPA_WEB_REVIEWS.max + 1 }).success).toBe(false)
    expect(streamSchemas.createAppConnectorArgsSchema.safeParse({ ...web, max_reviews: SPA_WEB_REVIEWS.max + 1 }).success).toBe(false)
    expect(createAppConnectorArgs.safeParse({ source: 'app_reviews_ios', app_name: 'A', app_id: '1', max_reviews: 1 }).success).toBe(false)
  })
})
