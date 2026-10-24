/**
 * @fileoverview The SPA approval boundary of the connector write tools —
 * `create_scraper`, `update_scraper`, `create_app_connector` — and the pure
 * record builders their cards and executors share, so the card shows exactly
 * the record that is saved.
 *
 * Limits mirror `lambda/api/scrapers_handler.py` (`_scraper_shape_error`) and
 * the app-review manifests, and are IDENTICAL to the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/scraper-schemas.ts`):
 * `scraperSchemas.lockstep.test.ts` reads both files as text. The routes
 * re-validate everything (URL policy with DNS resolution included).
 *
 * @module assistant/approvals/scraperSchemas
 */
import { z } from 'zod'
import { dimensionDefaultsSchema, labelTagsSchema } from './schemas'
import type { ScraperConfig } from '../../api/types'

export const SPA_SCRAPER_LIMITS = {
  maxUrls: 25,
  maxUrlLength: 2048,
  maxTextField: 500,
  maxPaginationParam: 64,
  maxPages: 50,
  maxPaginationStart: 10_000,
  maxFrequencyMinutes: 43_200,
  maxScraperBytes: 8192,
} as const

export const SCRAPER_ID_RULE = /^[A-Za-z0-9_-]{1,64}$/
/** A Radar brand key on a scraper or connector (shared/radar_brands.brand_key, ASCII slugs; docs/radar.md). */
export const RADAR_BRAND_KEY_RULE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const radarBrandArg = z.string().trim().regex(RADAR_BRAND_KEY_RULE, 'must be a Radar brand key')
export const SCRAPER_METHODS = ['css', 'jsonld'] as const
export const SELECTOR_KEYS = [
  'container_selector', 'text_selector', 'title_selector', 'rating_selector', 'rating_attribute',
  'date_selector', 'author_selector', 'link_selector',
] as const

const LOCAL_NAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])
const ALL_DIGITS = /^\d+$/

/** Why `value` is not a public https URL (client-side half of shared/url_policy), else null. */
function urlRuleProblem(value: string): string | null {
  if (!URL.canParse(value)) return 'must be an absolute URL'
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') return 'must use https'
  if (parsed.username !== '' || parsed.password !== '') return 'must not embed credentials'
  const hostname = parsed.hostname.replace(/\.$/, '')
  if (LOCAL_NAMES.has(hostname) || hostname.endsWith('.localhost')) return 'must not point at localhost'
  const labels = hostname.split('.')
  const ipv4 = labels.length === 4 && labels.every((label) => ALL_DIGITS.test(label))
  if (hostname.startsWith('[') || ipv4) return 'must use a host name, not an IP address'
  if (labels.length < 2) return 'must use a fully qualified public host name'
  return null
}

const publicUrl = z.string().trim().max(SPA_SCRAPER_LIMITS.maxUrlLength).check((ctx) => {
  const problem = urlRuleProblem(ctx.value)
  if (problem !== null) ctx.issues.push({ code: 'custom', message: `URL ${problem}`, input: ctx.value })
})
const selectorText = z.string().trim().max(SPA_SCRAPER_LIMITS.maxTextField).optional()
const scraperIdArg = z.string().regex(SCRAPER_ID_RULE, 'must be 1-64 letters, digits, "_" or "-"')

const editableFields = {
  name: z.string().trim().min(1).max(SPA_SCRAPER_LIMITS.maxTextField).optional(),
  base_url: publicUrl.optional(),
  urls: z.array(publicUrl).max(SPA_SCRAPER_LIMITS.maxUrls).optional(),
  extraction_method: z.enum(SCRAPER_METHODS).optional(),
  container_selector: selectorText,
  text_selector: selectorText,
  title_selector: selectorText,
  rating_selector: selectorText,
  rating_attribute: selectorText,
  date_selector: selectorText,
  author_selector: selectorText,
  link_selector: selectorText,
  pagination: z.strictObject({
    enabled: z.boolean(),
    param: z.string().trim().min(1).max(SPA_SCRAPER_LIMITS.maxPaginationParam).optional(),
    max_pages: z.int().min(1).max(SPA_SCRAPER_LIMITS.maxPages).optional(),
    start: z.int().min(0).max(SPA_SCRAPER_LIMITS.maxPaginationStart).optional(),
  }).optional(),
  frequency_minutes: z.int().min(0).max(SPA_SCRAPER_LIMITS.maxFrequencyMinutes).optional(),
  enabled: z.boolean().optional(),
  dimension_defaults: dimensionDefaultsSchema.optional(),
  tags: labelTagsSchema.optional(),
  /** '' = no longer a Radar source (an update only). */
  radar_brand: z.union([radarBrandArg, z.literal('')]).optional(),
} satisfies Record<string, z.ZodType>

/** The create shape before its cross-field rules (the record builder's input type comes from here). */
export const createScraperShape = z.strictObject({
  ...editableFields,
  id: scraperIdArg,
  name: z.string().trim().min(1).max(SPA_SCRAPER_LIMITS.maxTextField),
  extraction_method: z.enum(SCRAPER_METHODS),
  radar_brand: radarBrandArg.optional(),
})

export const createScraperArgs = createScraperShape
  .refine((a) => (a.base_url ?? '') !== '' || (a.urls ?? []).length > 0, { message: 'give base_url or at least one url' })
  .refine((a) => scraperRecordProblem(createdScraperRecord(a)) === null, { message: 'the scraper config is incomplete or too large' })

export const updateScraperArgs = z.strictObject({
  scraper_id: scraperIdArg,
  updates: z.strictObject(editableFields).refine((u) => Object.keys(u).length > 0, { message: 'updates must change at least one field' }),
})

export type CreateScraperArgs = z.infer<typeof createScraperShape>
export type UpdateScraperArgs = z.infer<typeof updateScraperArgs>
export type ScraperUpdates = UpdateScraperArgs['updates']

// ── Records (what the card shows = what is saved) ───────────────────────────

const DEFAULT_PAGINATION: ScraperConfig['pagination'] = { enabled: false, param: 'page', max_pages: 1, start: 1 }

/** The complete record a create saves: omitted fields take their OFF defaults (disabled, manual runs only). */
export function createdScraperRecord(args: CreateScraperArgs): ScraperConfig {
  const { pagination, ...rest } = args
  return {
    ...rest,
    enabled: args.enabled ?? false,
    base_url: args.base_url ?? '',
    urls: args.urls ?? [],
    frequency_minutes: args.frequency_minutes ?? 0,
    container_selector: args.container_selector ?? '',
    text_selector: args.text_selector ?? '',
    pagination: { ...DEFAULT_PAGINATION, ...pagination },
  }
}

/** The stored scraper with the proposed fields replacing theirs (pagination merged key by key). */
export function mergedScraperRecord(base: ScraperConfig, updates: ScraperUpdates): ScraperConfig {
  const { pagination, ...rest } = updates
  return { ...base, ...rest, pagination: { ...base.pagination, ...pagination } }
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** Why `record` must not be saved (css without selectors, over the size budget), else null. */
export function scraperRecordProblem(record: ScraperConfig): string | null {
  const css = record.extraction_method === 'css'
  if (css && (record.container_selector.trim() === '' || record.text_selector.trim() === '')) {
    return 'A css scraper needs container_selector and text_selector.'
  }
  if (byteLength(record) > SPA_SCRAPER_LIMITS.maxScraperBytes) {
    return `A scraper config may be at most ${SPA_SCRAPER_LIMITS.maxScraperBytes} bytes.`
  }
  return null
}

/** Order-independent JSON of a record: equal fingerprints = the same stored scraper. */
export function scraperFingerprint(record: unknown): string {
  return JSON.stringify(record, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  })
}

// ── App-review connectors ───────────────────────────────────────────────────

export const APP_SOURCES = ['app_reviews_ios', 'app_reviews_android', 'web_reviews'] as const
export type AppSource = (typeof APP_SOURCES)[number]
export const SORT_ORDERS_BY_SOURCE = {
  app_reviews_ios: ['most_recent'],
  app_reviews_android: ['newest', 'rating'],
  web_reviews: [],
} as const satisfies Record<AppSource, readonly string[]>
export const APP_FREQUENCIES = [0, 15, 30, 60, 180, 360, 720, 1440] as const
export const SPA_APP_LIMITS = { maxAppName: 100, maxPackageName: 255, maxReviewsPerRun: 5000, maxAppIdLength: 15 } as const
export const SPA_APP_DEFAULTS = { maxReviewsPerRun: 500, frequencyMinutes: 0 } as const
/** web_reviews `max_pages` (lambda/shared/web_review_targets.py); 0 = all pages. */
export const SPA_WEB_PAGES = { min: 0, max: 100, default: 10 } as const
/** web_reviews `max_reviews` (lambda/shared/web_review_targets.py); 0 = no review limit. */
export const SPA_WEB_REVIEWS = { min: 0, max: 5000, default: 0 } as const
/** The field each source names its target by. */
export const APP_ID_FIELD = {
  app_reviews_ios: 'app_id', app_reviews_android: 'package_name', web_reviews: 'url',
} as const satisfies Record<AppSource, string>
/** The fields only that source takes. */
const FIELDS_BY_SOURCE = {
  app_reviews_ios: ['app_id', 'sort_by', 'max_reviews_per_run'],
  app_reviews_android: ['package_name', 'sort_by', 'max_reviews_per_run'],
  web_reviews: ['url', 'max_pages', 'max_reviews'],
} as const satisfies Record<AppSource, readonly string[]>
const SOURCE_ONLY_FIELDS = [...new Set(Object.values(FIELDS_BY_SOURCE).flat())]

const APP_LABEL_RULE = /^[A-Za-z0-9][\w .-]*$/
const JAVA_SEGMENT = /^[A-Za-z]\w*$/
const isJavaPackage = (value: string) => {
  const parts = value.split('.')
  return parts.length > 1 && parts.every((part) => JAVA_SEGMENT.test(part))
}

export const createAppConnectorArgs = z.strictObject({
  source: z.enum(APP_SOURCES),
  app_name: z.string().trim().min(1).max(SPA_APP_LIMITS.maxAppName).regex(APP_LABEL_RULE, 'letters, digits, spaces, ".", "_" or "-"'),
  app_id: z.string().trim().min(1).max(SPA_APP_LIMITS.maxAppIdLength).regex(ALL_DIGITS, 'the numeric App Store id').optional(),
  package_name: z.string().trim().max(SPA_APP_LIMITS.maxPackageName).refine(isJavaPackage, 'a package name like com.example.app').optional(),
  url: publicUrl.optional(),
  sort_by: z.enum(['most_recent', 'newest', 'rating']).optional(),
  max_reviews_per_run: z.int().min(1).max(SPA_APP_LIMITS.maxReviewsPerRun).optional(),
  max_pages: z.int().min(SPA_WEB_PAGES.min).max(SPA_WEB_PAGES.max).optional(),
  max_reviews: z.int().min(SPA_WEB_REVIEWS.min).max(SPA_WEB_REVIEWS.max).optional(),
  frequency_minutes: z.union(APP_FREQUENCIES.map((n) => z.literal(n))).optional(),
  radar_brand: radarBrandArg.optional(),
}).check((ctx) => {
  const args = ctx.value
  const wanted = APP_ID_FIELD[args.source]
  const own: readonly string[] = FIELDS_BY_SOURCE[args.source]
  const issue = (path: string, message: string) => ctx.issues.push({ code: 'custom', path: [path], message, input: args })
  if (args[wanted] === undefined) issue(wanted, `${args.source} needs ${wanted}`)
  SOURCE_ONLY_FIELDS.filter((field) => !own.includes(field) && args[field] !== undefined)
    .forEach((field) => issue(field, `${args.source} does not take ${field}`))
  const orders: readonly string[] = SORT_ORDERS_BY_SOURCE[args.source]
  if (args.sort_by !== undefined && orders.length > 0 && !orders.includes(args.sort_by)) issue('sort_by', `one of ${orders.join(', ')}`)
})

export type CreateAppConnectorArgs = z.infer<typeof createAppConnectorArgs>

/** The config a create saves (string values, as the route stores them; the server mints the id). */
export function appConnectorRecord(args: CreateAppConnectorArgs): Record<string, string> {
  const frequency = String(args.frequency_minutes ?? SPA_APP_DEFAULTS.frequencyMinutes)
  // Absent = an ordinary source; the card's "Radar source" row reads it from here.
  const radar: Record<string, string> = args.radar_brand === undefined ? {} : { radar_brand: args.radar_brand }
  if (args.source === 'web_reviews') {
    return {
      app_name: args.app_name,
      url: args.url ?? '',
      max_pages: String(args.max_pages ?? SPA_WEB_PAGES.default),
      max_reviews: String(args.max_reviews ?? SPA_WEB_REVIEWS.default),
      frequency_minutes: frequency,
      ...radar,
    }
  }
  const idField = APP_ID_FIELD[args.source]
  return {
    app_name: args.app_name,
    [idField]: args[idField] ?? '',
    sort_by: args.sort_by ?? SORT_ORDERS_BY_SOURCE[args.source][0],
    max_reviews_per_run: String(args.max_reviews_per_run ?? SPA_APP_DEFAULTS.maxReviewsPerRun),
    frequency_minutes: frequency,
    ...radar,
  }
}
