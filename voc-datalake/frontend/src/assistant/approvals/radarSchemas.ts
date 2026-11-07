/**
 * @fileoverview The SPA approval boundary of the Radar write tools —
 * `save_radar_brands` (the whole brand list → PUT /radar/brands) and
 * `run_radar_scan` (POST /radar/scan) — plus the stored-list fingerprint their
 * cards share; GET /radar/brands is read through `radarApi.getBrands` (docs/radar.md).
 *
 * The limits, patterns and rule functions are the stream Lambda's
 * (`@stream/assistant/tools/client/radar-schemas`, pinned there to
 * `lambda/shared/radar_brands.py` and its siblings); this file words the card's
 * own messages (`radarSchemas.test.ts` checks it accepts what the stream accepts).
 * The route re-validates everything.
 *
 * @module assistant/approvals/radarSchemas
 */
import { z } from 'zod'
import {
  BRAND_LABEL_PATTERN, MAX_DOMAIN_INPUT, MAX_LABEL_INPUT, RADAR_BRAND_LANGUAGES, RADAR_BRAND_LIMITS as L,
  isBrandDomain, isBrandTerm, isFeedUrl, normalizedBrandDomain, radarBrandKey,
} from '@stream/assistant/tools/client/radar-schemas'
import { RADAR_BRAND_KEY_RULE } from './scraperSchemas'
import type { RadarBrandEntry } from '../../api/radarSchema'
import type { RadarLanguage } from '../../api/radarNewsFields'

const feedUrl = z.string().max(L.maxFeedUrlChars + 50).transform((raw) => raw.trim())
  .pipe(z.string().refine(isFeedUrl, 'an https feed URL like https://example.com/feed'))

/** shared/radar_brand_terms.brand_terms: whitespace folded, checked, de-duplicated without regard to case, then capped. */
const brandTerms = z.array(z.string().max(MAX_LABEL_INPUT).transform((raw) => raw.trim().split(/\s+/).join(' '))
  .pipe(z.string().refine(isBrandTerm, '1-60 characters, no double quotes, not starting with "-"')))
  .max(L.maxTerms * 2)
  .transform((terms) => terms.filter((term, index) => terms.findIndex((other) => other.toLowerCase() === term.toLowerCase()) === index))
  .pipe(z.array(z.string()).max(L.maxTerms))

const brandLabel = z.string().max(MAX_LABEL_INPUT)
  .transform((raw) => raw.trim().split(/\s+/).join(' '))
  .pipe(z.string().regex(BRAND_LABEL_PATTERN, 'letters, digits, spaces or . & \' + -').refine((label) => radarBrandKey(label) !== '', 'needs a letter or digit'))
const brandHost = z.string().max(MAX_DOMAIN_INPUT).transform(normalizedBrandDomain)
  .pipe(z.string().refine(isBrandDomain, 'a domain name like example.com'))

export const saveRadarBrandsArgs = z.strictObject({
  brands: z.array(z.strictObject({
    label: brandLabel,
    domains: z.array(brandHost).max(L.maxDomains).transform((hosts) => Array.from(new Set(hosts))).optional(),
    language: z.enum(RADAR_BRAND_LANGUAGES).nullable().optional(),
    // De-duplicated first, then capped (shared/radar_brand_fields.feed_urls).
    feed_urls: z.array(feedUrl).max(L.maxFeedUrls * 2).transform((urls) => Array.from(new Set(urls)))
      .pipe(z.array(z.string()).max(L.maxFeedUrls)).optional(),
    search_terms: brandTerms.optional(),
    exclude_terms: brandTerms.optional(),
  })).max(L.maxBrands),
}).check((ctx) => {
  const keys = ctx.value.brands.map((brand) => radarBrandKey(brand.label))
  const repeats = keys.flatMap((key, index) => (keys.indexOf(key) === index ? [] : [{ key, index }]))
  ctx.issues.push(...repeats.map(({ key, index }) => ({
    code: 'custom' as const, path: ['brands', index, 'label'], message: `two brands share the key "${key}"`, input: ctx.value,
  })))
})
export type SaveRadarBrandsArgs = z.infer<typeof saveRadarBrandsArgs>

export const runRadarScanArgs = z.strictObject({ brand: z.string().trim().regex(RADAR_BRAND_KEY_RULE).optional() })
export type RunRadarScanArgs = z.infer<typeof runRadarScanArgs>

/** The news-scan fields a saved brand carries beyond its label and domains. */
export interface SavedNewsFields {
  language: RadarLanguage | null
  feed_urls: string[]
  search_terms: string[]
  exclude_terms: string[]
}

/**
 * The language, feeds and terms a save_radar_brands brand is saved with: the ones the card names, else the stored
 * brand's (the tool may name none; PUT /radar/brands replaces the whole list). Shared by the preview and the executor.
 */
export function savedNewsFields(brand: SaveRadarBrandsArgs['brands'][number],
  was: Pick<RadarBrandEntry, 'language' | 'feed_urls' | 'search_terms' | 'exclude_terms'> | undefined): SavedNewsFields {
  return {
    language: brand.language === undefined ? was?.language ?? null : brand.language,
    feed_urls: namedOrStored(brand.feed_urls, was?.feed_urls),
    search_terms: namedOrStored(brand.search_terms, was?.search_terms),
    exclude_terms: namedOrStored(brand.exclude_terms, was?.exclude_terms),
  }
}

/** The list the card names, else the stored brand's, else none (a copy either way). */
function namedOrStored(named: readonly string[] | undefined, stored: readonly string[] | undefined): string[] {
  return [...(named ?? stored ?? [])]
}

/**
 * Order-independent fingerprint of the stored LIST brands (what save_radar_brands replaces): key, label,
 * domains, language, feeds and terms, so a card shown before any of them changed is refused as stale.
 */
export function radarListFingerprint(entries: readonly RadarBrandEntry[]): string {
  return JSON.stringify(entries.filter((entry) => entry.origin === 'list')
    .map((entry) => [entry.key, entry.label, [...entry.domains].sort((a, b) => a.localeCompare(b)),
      entry.language ?? null, [...entry.feed_urls].sort((a, b) => a.localeCompare(b)), entry.search_terms, entry.exclude_terms])
    .sort(([a], [b]) => String(a).localeCompare(String(b))))
}
