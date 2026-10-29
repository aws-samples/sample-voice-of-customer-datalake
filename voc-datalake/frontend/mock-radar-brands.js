// Radar brand list mock (docs/radar.md): GET|PUT /radar/brands in the lambda/api/radar_handler.py
// wire shape, with each brand's search `language` (null = auto), `effective_language` and `feed_urls`. The list lives at voc-radar `SETTINGS#radar/brands`; the effective brands are the
// list, then legacy source-profile brands (`radar_brand` on a profile) merged by key, each with
// its `origin`. Also the `radar_brand` slug check the scraper and connector saves apply.
// Stateful for the life of the mock process. Used by mock-radar.js and mock-server.js.

const MAX_BRANDS = 25;
const MAX_DOMAINS = 10;
const BRAND_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const BRAND_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_FEEDS = 3;
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 60;
const LANGUAGES = ['en', 'pl', 'cs', 'sk', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'fi', 'no', 'hu', 'ro'];
// The domain's TLD → the language Auto searches in (shared/radar_brands.py), else English.
const TLD_LANGUAGES = {
  pl: 'pl', cz: 'cs', sk: 'sk', de: 'de', at: 'de', fr: 'fr', es: 'es', it: 'it', pt: 'pt', br: 'pt',
  nl: 'nl', se: 'sv', dk: 'da', fi: 'fi', no: 'no', hu: 'hu', ro: 'ro',
};

// One list brand to start with, next to the legacy profile brand (Acme on `rival_reviews`).
// A second list brand on a .pl domain shows Auto resolving to Polish, with a news feed.
const state = {
  list: [
    { label: 'Globex', domains: ['globex.example'], language: null, feed_urls: [] },
    { label: 'Example Air', domains: ['example.pl'], language: null, feed_urls: ['https://example.pl/news/feed.xml'],
      search_terms: ['Example Air S.A.'], exclude_terms: ['air conditioning'] },
  ],
};

/** The language Auto resolves to: the set one, else the first domain's TLD, else English. */
function effectiveLanguage(language, domains) {
  if (language) return language;
  const tld = String(domains[0] ?? '').split('.').pop();
  return TLD_LANGUAGES[tld] ?? 'en';
}

/** shared/radar_brands.brand_key: runs of non-word characters fold to one '-', none at the ends. */
const brandKey = (name) => name.trim().toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).join('-');

/** The 400 message for a `radar_brand` that is not a brand key, or null (absent / empty = an ordinary source). */
export function radarBrandError(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && BRAND_SLUG.test(value) ? null : 'radar_brand must be a Radar brand key';
}

function profileBrands(shared) {
  const byKey = new Map();
  for (const profile of shared.sourceProfiles()) {
    if (typeof profile.radar_brand !== 'string' || !profile.radar_brand) continue;
    const key = brandKey(profile.radar_brand);
    const entry = byKey.get(key) ?? {
      key, label: profile.radar_brand, domains: [], origin: 'profile', sources: [], language: null, effective_language: 'en', feed_urls: [],
      search_terms: [], exclude_terms: [],
    };
    for (const domain of profile.radar_domains ?? []) if (!entry.domains.includes(domain)) entry.domains.push(domain);
    entry.sources.push(String(profile.id ?? ''));
    entry.effective_language = effectiveLanguage(null, entry.domains);
    byKey.set(key, entry);
  }
  return byKey;
}

/** The effective brands: the list first, then the legacy profile brands it does not already name. */
export function effectiveBrands(shared) {
  const legacy = profileBrands(shared);
  const listed = state.list.map(({ label, domains, language, feed_urls: feeds, search_terms: search = [], exclude_terms: exclude = [] }) => ({
    key: brandKey(label), label, domains: [...domains], origin: 'list', sources: [],
    language, effective_language: effectiveLanguage(language, domains), feed_urls: [...feeds],
    search_terms: [...search], exclude_terms: [...exclude],
  }));
  const keys = new Set(listed.map((brand) => brand.key));
  return [...listed, ...[...legacy.values()].filter((brand) => !keys.has(brand.key))];
}

function cleanDomain(raw) {
  const host = String(raw ?? '').trim().toLowerCase().replace(/^https?:\/\//u, '').split('/')[0].replace(/^www\./u, '');
  return DOMAIN.test(host) ? host : null;
}

function validDomains(raw, label) {
  if (raw === undefined || raw === null) return { domains: [] };
  if (!Array.isArray(raw)) return { error: `${label}: domains must be a list` };
  if (raw.length > MAX_DOMAINS) return { error: `${label}: at most ${MAX_DOMAINS} domains` };
  const domains = [];
  for (const entry of raw) {
    const host = cleanDomain(entry);
    if (host === null) return { error: `${label}: not a domain name: ${String(entry).slice(0, 80)}` };
    if (!domains.includes(host)) domains.push(host);
  }
  return { domains };
}

function validLanguage(raw, label) {
  if (raw === undefined || raw === null) return { language: null };
  return LANGUAGES.includes(raw) ? { language: raw } : { error: `${label}: language must be one of ${LANGUAGES.join(', ')}` };
}

/** An https link with a host (URL parsing, no pattern). */
function isHttpsUrl(entry) {
  if (typeof entry !== 'string' || !entry.trim().startsWith('https://')) return false;
  try {
    return new URL(entry.trim()).hostname.includes('.');
  } catch {
    return false;
  }
}

function validFeeds(raw, label) {
  if (raw === undefined || raw === null) return { feeds: [] };
  if (!Array.isArray(raw)) return { error: `${label}: feed_urls must be a list` };
  if (raw.length > MAX_FEEDS) return { error: `${label}: at most ${MAX_FEEDS} news feeds` };
  const feeds = [];
  for (const entry of raw) {
    if (!isHttpsUrl(entry)) {
      return { error: `${label}: a news feed must be an https link: ${String(entry).slice(0, 80)}` };
    }
    if (!feeds.includes(entry.trim())) feeds.push(entry.trim());
  }
  return { feeds };
}

/** shared/radar_brand_terms.brand_terms: whitespace folded, 1-60 characters, no `"`, no leading "-", ≤ 8 after de-duplication. */
function validTerms(raw, label, field) {
  if (raw === undefined || raw === null) return { terms: [] };
  if (!Array.isArray(raw)) return { error: `${label} ${field} must be a list of words or phrases` };
  const terms = [];
  for (const [number, entry] of raw.entries()) {
    const term = typeof entry === 'string' ? entry.split(/\s+/u).filter(Boolean).join(' ') : '';
    if (term === '' || term.length > MAX_TERM_CHARS || term.includes('"') || term.startsWith('-')) {
      return { error: `${label} ${field} entry ${number + 1} must be 1-${MAX_TERM_CHARS} characters, no double quotes, not starting with "-"` };
    }
    if (!terms.some((kept) => kept.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  return terms.length > MAX_TERMS ? { error: `${label} may have at most ${MAX_TERMS} ${field.replace('_', ' ')}` } : { terms };
}

function validBrand(raw, index, seen) {
  const what = `brands[${index}]`;
  const label = typeof raw?.label === 'string' ? raw.label.split(/\s+/u).filter(Boolean).join(' ') : '';
  if (!BRAND_NAME.test(label) || !brandKey(label)) {
    return { error: `${what} label must be 1-64 characters of letters, digits, spaces or . & ' + -` };
  }
  if (seen.has(brandKey(label))) return { error: `${what}: ${label} is already in the list` };
  seen.add(brandKey(label));
  const domains = validDomains(raw.domains, what);
  const language = validLanguage(raw.language, what);
  const feeds = validFeeds(raw.feed_urls, what);
  const search = validTerms(raw.search_terms, what, 'search_terms');
  const exclude = validTerms(raw.exclude_terms, what, 'exclude_terms');
  const error = domains.error ?? language.error ?? feeds.error ?? search.error ?? exclude.error;
  if (error) return { error };
  return { brand: {
    label, domains: domains.domains, language: language.language, feed_urls: feeds.feeds,
    search_terms: search.terms, exclude_terms: exclude.terms,
  } };
}

function putBrands(body, shared) {
  const raw = body?.brands;
  if (!Array.isArray(raw)) return [400, { success: false, error: 'brands must be a list' }];
  if (raw.length > MAX_BRANDS) return [400, { success: false, error: `at most ${MAX_BRANDS} brands` }];
  const seen = new Set();
  const list = [];
  for (const [index, entry] of raw.entries()) {
    const { brand, error } = validBrand(entry, index, seen);
    if (error) return [400, { success: false, error }];
    list.push(brand);
  }
  state.list = list;
  return [200, { success: true, brands: effectiveBrands(shared) }];
}

/** [status, payload] for /radar/brands: GET, PUT, else 405. */
export function brandListRoute(method, body, shared) {
  if (method === 'GET') return [200, { brands: effectiveBrands(shared) }];
  if (method === 'PUT') return putBrands(body, shared);
  return [405, { success: false, error: 'Method not allowed' }];
}
