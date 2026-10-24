// Radar brand list mock (docs/radar.md): GET|PUT /radar/brands in the lambda/api/radar_handler.py
// wire shape. The list lives at voc-radar `SETTINGS#radar/brands`; the effective brands are the
// list, then legacy source-profile brands (`radar_brand` on a profile) merged by key, each with
// its `origin`. Also the `radar_brand` slug check the scraper and connector saves apply.
// Stateful for the life of the mock process. Used by mock-radar.js and mock-server.js.

const MAX_BRANDS = 25;
const MAX_DOMAINS = 10;
const BRAND_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ .&'+-]{0,63}$/u;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const BRAND_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

// One list brand to start with, next to the legacy profile brand (Acme on `rival_reviews`).
const state = { list: [{ label: 'Globex', domains: ['globex.example'] }] };

/** shared/radar_brands.brand_key: runs of non-word characters fold to one '-', none at the ends. */
export const brandKey = (name) => name.trim().toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).join('-');

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
    const entry = byKey.get(key) ?? { key, label: profile.radar_brand, domains: [], origin: 'profile', sources: [] };
    for (const domain of profile.radar_domains ?? []) if (!entry.domains.includes(domain)) entry.domains.push(domain);
    entry.sources.push(String(profile.id ?? ''));
    byKey.set(key, entry);
  }
  return byKey;
}

/** The effective brands: the list first, then the legacy profile brands it does not already name. */
export function effectiveBrands(shared) {
  const legacy = profileBrands(shared);
  const listed = state.list.map(({ label, domains }) => ({
    key: brandKey(label), label, domains: [...domains], origin: 'list', sources: [],
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

function validBrand(raw, index, seen) {
  const what = `brands[${index}]`;
  const label = typeof raw?.label === 'string' ? raw.label.split(/\s+/u).filter(Boolean).join(' ') : '';
  if (!BRAND_NAME.test(label) || !brandKey(label)) {
    return { error: `${what} label must be 1-64 characters of letters, digits, spaces or . & ' + -` };
  }
  if (seen.has(brandKey(label))) return { error: `${what}: ${label} is already in the list` };
  seen.add(brandKey(label));
  const { domains, error } = validDomains(raw.domains, what);
  return error ? { error } : { brand: { label, domains } };
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
