/**
 * Argument schemas of the Radar write tools (`scrapers` pack, admin-only):
 * `save_radar_brands` (the whole brand list, PUT /radar/brands) and
 * `run_radar_scan` (POST /radar/scan). docs/radar.md.
 *
 * Bounds mirror `lambda/shared/radar_brands.py` (`MAX_BRAND_CHARS`,
 * `MAX_BRAND_DOMAINS`, `_BRAND_RE`, `DOMAIN_RE`, `brand_key`, `_domain`'s
 * normalisation), `lambda/shared/radar_brand_fields.py` (`LANGUAGES`,
 * `MAX_FEED_URLS`, `MAX_FEED_URL_CHARS`, the feed URL shape), `lambda/shared/radar_brand_terms.py`
 * (`MAX_TERMS`, `MAX_TERM_CHARS`, the term rules of search_terms / exclude_terms) and the route's
 * 25-brand cap; the route re-validates.
 *
 * LOCKSTEP: the SPA boundary (`frontend/src/assistant/approvals/radarSchemas.ts`)
 * holds the same limits and patterns; `radarSchemas.lockstep.test.ts` reads this
 * file and radar_brands.py as text and fails when they drift.
 */
import { z } from 'zod';
import { radarBrandKeySchema } from './scraper-schemas.js';

export const RADAR_BRAND_LIMITS = {
  maxBrands: 25, maxLabelChars: 64, maxDomains: 10, maxFeedUrls: 3, maxFeedUrlChars: 500, maxTerms: 8, maxTermChars: 60,
} as const;
/** radar_brand_fields.LANGUAGES: the languages a brand may name (absent / null = auto). */
export const RADAR_BRAND_LANGUAGES = ['en', 'pl', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'hu', 'ro'] as const;
/** url_policy.BLOCKED_HOSTNAMES. */
const BLOCKED_FEED_HOSTS: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/** radar_brands._BRAND_RE: letters (any script), digits, spaces and . & ' + - */
const BRAND_LABEL_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u;
/** radar_brands.DOMAIN_RE, as checks without backtracking: dotted labels of 1-63 [a-z0-9-] not starting or ending with "-", an alphabetic TLD. */
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

/** Whether `host` (already normalised) is a domain name radar_brands.DOMAIN_RE accepts. */
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

/** An IPv4 or IPv6 literal (url_policy judges those as written; a feed must name a host). */
function isIpLiteral(host: string): boolean {
  const parts = host.split('.');
  return host.startsWith('[') || (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part)));
}

/** A dotted public host name: not localhost, not an IP literal. */
function isFeedHost(url: URL): boolean {
  const host = url.hostname.replace(/\.$/, '');
  return host.includes('.') && !BLOCKED_FEED_HOSTS.has(host) && !isIpLiteral(host);
}

/** radar_brand_fields._feed_url_problem: https, a dotted public host name, no credentials, no fragment, no spaces. */
function isFeedUrl(raw: string): boolean {
  if (raw.length > RADAR_BRAND_LIMITS.maxFeedUrlChars || /[\s\p{Cc}]/u.test(raw) || raw.includes('#')) return false;
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  const credentials = url.username !== '' || url.password !== '' || (raw.split('/')[2] ?? '').includes('@');
  return !credentials && url.protocol === 'https:' && isFeedHost(url);
}

const feedUrlSchema = z.string().max(RADAR_BRAND_LIMITS.maxFeedUrlChars + 50).transform((raw) => raw.trim())
  .pipe(z.string().refine(isFeedUrl, 'must be an https feed URL like https://example.com/feed'));

/** radar_brand_terms._term_problem: whitespace folded, 1-60 characters, no control character, no `"`, no leading "-". */
function isBrandTerm(term: string): boolean {
  return term !== '' && term.length <= RADAR_BRAND_LIMITS.maxTermChars && !/\p{Cc}/u.test(term)
    && !term.includes('"') && !term.startsWith('-');
}

/** radar_brand_terms.brand_terms: each term checked, then de-duplicated without regard to case, then capped. */
const termsSchema = z.array(z.string().max(MAX_LABEL_INPUT).transform((raw) => raw.split(/\s+/).filter(Boolean).join(' '))
  .pipe(z.string().refine(isBrandTerm, `1-${RADAR_BRAND_LIMITS.maxTermChars} characters, no double quotes, not starting with "-"`)))
  .max(RADAR_BRAND_LIMITS.maxTerms * 2)
  .transform((terms) => terms.filter((term, index) => terms.findIndex((other) => other.toLowerCase() === term.toLowerCase()) === index))
  .pipe(z.array(z.string()).max(RADAR_BRAND_LIMITS.maxTerms));

const brandSchema = z.object({
  label: labelSchema,
  domains: z.array(domainSchema).max(RADAR_BRAND_LIMITS.maxDomains)
    .transform((domains) => [...new Set(domains)]).optional(),
  language: z.enum(RADAR_BRAND_LANGUAGES).nullable().optional(),
  // De-duplicated first, then capped, like radar_brand_fields.feed_urls.
  feed_urls: z.array(feedUrlSchema).max(RADAR_BRAND_LIMITS.maxFeedUrls * 2)
    .transform((urls) => [...new Set(urls)]).pipe(z.array(z.string()).max(RADAR_BRAND_LIMITS.maxFeedUrls)).optional(),
  search_terms: termsSchema.optional(),
  exclude_terms: termsSchema.optional(),
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
