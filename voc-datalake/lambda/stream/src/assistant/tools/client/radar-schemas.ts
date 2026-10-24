/**
 * Argument schemas of the Radar write tools (`scrapers` pack, admin-only):
 * `save_radar_brands` (the whole brand list, PUT /radar/brands) and
 * `run_radar_scan` (POST /radar/scan). docs/radar.md.
 *
 * Bounds mirror `lambda/shared/radar_brands.py` (`MAX_BRAND_CHARS`,
 * `MAX_BRAND_DOMAINS`, `_BRAND_RE`, `_DOMAIN_RE`, `brand_key`, `_domain`'s
 * normalisation) and the route's 25-brand cap; the route re-validates.
 *
 * LOCKSTEP: the SPA boundary (`frontend/src/assistant/approvals/radarSchemas.ts`)
 * holds the same limits and patterns; `radarSchemas.lockstep.test.ts` reads this
 * file and radar_brands.py as text and fails when they drift.
 */
import { z } from 'zod';
import { radarBrandKeySchema } from './scraper-schemas.js';

export const RADAR_BRAND_LIMITS = { maxBrands: 25, maxLabelChars: 64, maxDomains: 10 } as const;

/** radar_brands._BRAND_RE: letters (any script), digits, spaces and . & ' + - */
const BRAND_LABEL_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u;
/** radar_brands._DOMAIN_RE, as checks without backtracking: dotted labels of 1-63 [a-z0-9-] not starting or ending with "-", an alphabetic TLD. */
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;
const DOMAIN_TLD = /^[a-z]{2,63}$/;
const MAX_DOMAIN_CHARS = 253;
/** Raw input caps before normalisation (whitespace collapse, scheme/path strip); the patterns bound the result. */
const MAX_LABEL_INPUT = 128;
const MAX_DOMAIN_INPUT = 300;
const KEY_EDGE: ReadonlySet<string> = new Set(['-', '_']);

/** `value` without leading and trailing "-" / "_" (Python's `.strip('-_')`). */
function trimKeyEdges(value: string): string {
  const chars = [...value];
  const start = chars.findIndex((char) => !KEY_EDGE.has(char));
  if (start < 0) return '';
  const fromEnd = [...chars].reverse().findIndex((char) => !KEY_EDGE.has(char));
  return chars.slice(start, chars.length - fromEnd).join('');
}

/** radar_brands.brand_key: lower-cased, every run of non-word characters folded to one '-', none at the ends. */
export function radarBrandKey(label: string): string {
  return trimKeyEdges(label.trim().toLowerCase().replaceAll(/[^\p{L}\p{N}_]+/gu, '-')).slice(0, RADAR_BRAND_LIMITS.maxLabelChars);
}

/** Whether `host` (already normalised) is a domain name radar_brands._DOMAIN_RE accepts. */
function isBrandDomain(host: string): boolean {
  const labels = host.split('.');
  const tld = labels.at(-1) ?? '';
  return host.length <= MAX_DOMAIN_CHARS && labels.length >= 2 && DOMAIN_TLD.test(tld)
    && labels.every((label) => DOMAIN_LABEL.test(label) && !label.startsWith('-') && !label.endsWith('-'));
}

/** radar_brands._domain: no scheme, no path, no leading `www.`, lower case. */
export function normalizedBrandDomain(raw: string): string {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, '').split('/', 1)[0] ?? '';
  return host.replace(/^www\./, '');
}

const labelSchema = z.string().max(MAX_LABEL_INPUT)
  .transform((raw) => raw.split(/\s+/).filter(Boolean).join(' '))
  .pipe(z.string().regex(BRAND_LABEL_PATTERN, `1-${RADAR_BRAND_LIMITS.maxLabelChars} characters of letters, digits, spaces or . & ' + -`)
    .refine((label) => radarBrandKey(label) !== '', 'must contain a letter or digit'));

const domainSchema = z.string().max(MAX_DOMAIN_INPUT).transform(normalizedBrandDomain)
  .pipe(z.string().refine(isBrandDomain, 'must be a domain name like example.com'));

const brandSchema = z.object({
  label: labelSchema,
  domains: z.array(domainSchema).max(RADAR_BRAND_LIMITS.maxDomains)
    .transform((domains) => [...new Set(domains)]).optional(),
}).strict();

export const saveRadarBrandsArgsSchema = z.object({
  brands: z.array(brandSchema).max(RADAR_BRAND_LIMITS.maxBrands),
}).strict().superRefine((args, ctx) => {
  const seen = new Set<string>();
  for (const [index, brand] of args.brands.entries()) {
    const key = radarBrandKey(brand.label);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['brands', index, 'label'], message: `two brands share the key "${key}"` });
    seen.add(key);
  }
});

export const runRadarScanArgsSchema = z.object({ brand: radarBrandKeySchema.optional() }).strict();
