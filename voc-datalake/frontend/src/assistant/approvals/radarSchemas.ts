/**
 * @fileoverview The SPA approval boundary of the Radar write tools —
 * `save_radar_brands` (the whole brand list → PUT /radar/brands) and
 * `run_radar_scan` (POST /radar/scan) — plus the stored-list fingerprint their
 * cards share; GET /radar/brands is read through `radarApi.getBrands` (docs/radar.md).
 *
 * Limits and rules are IDENTICAL to the stream Lambda's
 * (`lambda/stream/src/assistant/tools/client/radar-schemas.ts`) and to
 * `lambda/shared/radar_brands.py`: `radarSchemas.lockstep.test.ts` pins them.
 * The route re-validates everything.
 *
 * @module assistant/approvals/radarSchemas
 */
import { z } from 'zod'
import { RADAR_BRAND_KEY_RULE } from './scraperSchemas'
import type { RadarBrandEntry } from '../../api/radarSchema'
import type { RadarLanguage } from '../../api/radarNewsFields'

export const SPA_RADAR_LIMITS = {
  maxBrands: 25, maxLabelChars: 64, maxDomains: 10, maxFeedUrls: 3, maxFeedUrlChars: 500, maxTerms: 8, maxTermChars: 60,
} as const
/** shared/radar_brand_fields.LANGUAGES (absent / null = auto: from the first domain's TLD). */
export const SPA_RADAR_LANGUAGES = ['en', 'pl', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'hu', 'ro'] as const
/** shared/url_policy.BLOCKED_HOSTNAMES. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u

/** radar_brands._BRAND_RE (letters of any script, digits, spaces and . & ' + -). */
const LABEL_RULE = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u
const HOST_LABEL_RULE = /^[a-z0-9-]{1,63}$/
const TOP_LEVEL_RULE = /^[a-z]{2,63}$/
const MAX_HOST_CHARS = 253
const RAW_LABEL_CAP = 128
const RAW_DOMAIN_CAP = 300
const NOT_WORD = /[^\p{L}\p{N}_]+/gu
const SCHEME = /^https?:\/\//
const KEY_TRIM: ReadonlySet<string> = new Set(['-', '_'])

/** shared/radar_brands.brand_key: "Acme Air" → "acme-air" (`.strip('-_')`: no "-" / "_" at either end). */
export function brandKeyOf(label: string): string {
  const chars = [...label.trim().toLowerCase().replaceAll(NOT_WORD, '-')]
  const kept = (char: string) => !KEY_TRIM.has(char)
  const first = chars.findIndex(kept)
  if (first < 0) return ''
  const last = chars.length - [...chars].reverse().findIndex(kept)
  return chars.slice(first, last).join('').slice(0, SPA_RADAR_LIMITS.maxLabelChars)
}

/** radar_brands._domain: "https://www.Acme.example/x" → "acme.example". */
export function brandHostOf(raw: string): string {
  const host = raw.trim().toLowerCase().replace(SCHEME, '').split('/')[0] ?? ''
  return host.startsWith('www.') ? host.slice('www.'.length) : host
}

/** radar_brands.DOMAIN_RE without a backtracking pattern. */
function isHostName(host: string): boolean {
  const labels = host.split('.')
  const edgeOk = (label: string) => !label.startsWith('-') && !label.endsWith('-')
  return host.length <= MAX_HOST_CHARS && labels.length > 1 && TOP_LEVEL_RULE.test(labels.at(-1) ?? '')
    && labels.every((label) => HOST_LABEL_RULE.test(label) && edgeOk(label))
}

/** An IP literal: a feed must name a host (shared/url_policy judges IP literals as written). */
function isIpHost(host: string): boolean {
  const parts = host.split('.')
  return host.startsWith('[') || (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)))
}

function isPublicFeedHost(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, '')
  return host.includes('.') && !LOCAL_HOSTS.has(host) && !isIpHost(host)
}

/** shared/radar_brand_fields._feed_url_problem: https, a dotted public host, no credentials, fragment or spaces. */
function isFeedUrlOf(raw: string): boolean {
  if (raw.length > SPA_RADAR_LIMITS.maxFeedUrlChars || SPACE_OR_CONTROL.test(raw) || raw.includes('#')) return false
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  const withCredentials = url.username !== '' || url.password !== '' || (raw.split('/')[2] ?? '').includes('@')
  return !withCredentials && url.protocol === 'https:' && isPublicFeedHost(url)
}

const feedUrl = z.string().max(SPA_RADAR_LIMITS.maxFeedUrlChars + 50).transform((raw) => raw.trim())
  .pipe(z.string().refine(isFeedUrlOf, 'an https feed URL like https://example.com/feed'))

/** shared/radar_brand_terms._term_problem: 1-60 characters, no control character, no `"`, no leading "-". */
function isBrandTerm(term: string): boolean {
  return term !== '' && term.length <= SPA_RADAR_LIMITS.maxTermChars && !/\p{Cc}/u.test(term) && !term.includes('"') && !term.startsWith('-')
}

/** shared/radar_brand_terms.brand_terms: whitespace folded, checked, de-duplicated without regard to case, then capped. */
const brandTerms = z.array(z.string().max(RAW_LABEL_CAP).transform((raw) => raw.trim().split(/\s+/).join(' '))
  .pipe(z.string().refine(isBrandTerm, '1-60 characters, no double quotes, not starting with "-"')))
  .max(SPA_RADAR_LIMITS.maxTerms * 2)
  .transform((terms) => terms.filter((term, index) => terms.findIndex((other) => other.toLowerCase() === term.toLowerCase()) === index))
  .pipe(z.array(z.string()).max(SPA_RADAR_LIMITS.maxTerms))

const brandLabel = z.string().max(RAW_LABEL_CAP)
  .transform((raw) => raw.trim().split(/\s+/).join(' '))
  .pipe(z.string().regex(LABEL_RULE, 'letters, digits, spaces or . & \' + -').refine((label) => brandKeyOf(label) !== '', 'needs a letter or digit'))
const brandHost = z.string().max(RAW_DOMAIN_CAP).transform(brandHostOf)
  .pipe(z.string().refine(isHostName, 'a domain name like example.com'))

export const saveRadarBrandsArgs = z.strictObject({
  brands: z.array(z.strictObject({
    label: brandLabel,
    domains: z.array(brandHost).max(SPA_RADAR_LIMITS.maxDomains).transform((hosts) => Array.from(new Set(hosts))).optional(),
    language: z.enum(SPA_RADAR_LANGUAGES).nullable().optional(),
    // De-duplicated first, then capped (shared/radar_brand_fields.feed_urls).
    feed_urls: z.array(feedUrl).max(SPA_RADAR_LIMITS.maxFeedUrls * 2).transform((urls) => Array.from(new Set(urls)))
      .pipe(z.array(z.string()).max(SPA_RADAR_LIMITS.maxFeedUrls)).optional(),
    search_terms: brandTerms.optional(),
    exclude_terms: brandTerms.optional(),
  })).max(SPA_RADAR_LIMITS.maxBrands),
}).check((ctx) => {
  const keys = ctx.value.brands.map((brand) => brandKeyOf(brand.label))
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
