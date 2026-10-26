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

export const SPA_RADAR_LIMITS = { maxBrands: 25, maxLabelChars: 64, maxDomains: 10 } as const

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

/** radar_brands._DOMAIN_RE without a backtracking pattern. */
function isHostName(host: string): boolean {
  const labels = host.split('.')
  const edgeOk = (label: string) => !label.startsWith('-') && !label.endsWith('-')
  return host.length <= MAX_HOST_CHARS && labels.length > 1 && TOP_LEVEL_RULE.test(labels.at(-1) ?? '')
    && labels.every((label) => HOST_LABEL_RULE.test(label) && edgeOk(label))
}

const brandLabel = z.string().max(RAW_LABEL_CAP)
  .transform((raw) => raw.trim().split(/\s+/).join(' '))
  .pipe(z.string().regex(LABEL_RULE, 'letters, digits, spaces or . & \' + -').refine((label) => brandKeyOf(label) !== '', 'needs a letter or digit'))
const brandHost = z.string().max(RAW_DOMAIN_CAP).transform(brandHostOf)
  .pipe(z.string().refine(isHostName, 'a domain name like example.com'))

export const saveRadarBrandsArgs = z.strictObject({
  brands: z.array(z.strictObject({
    label: brandLabel,
    domains: z.array(brandHost).max(SPA_RADAR_LIMITS.maxDomains).transform((hosts) => Array.from(new Set(hosts))).optional(),
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

/** Order-independent fingerprint of the stored LIST brands (what save_radar_brands replaces). */
export function radarListFingerprint(entries: readonly RadarBrandEntry[]): string {
  return JSON.stringify(entries.filter((entry) => entry.origin === 'list')
    .map((entry) => [entry.key, entry.label, [...entry.domains].sort((a, b) => a.localeCompare(b))])
    .sort(([a], [b]) => String(a).localeCompare(String(b))))
}
