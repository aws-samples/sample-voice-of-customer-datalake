// Radar mock (docs/radar.md): GET /radar, GET /radar/all, GET /radar/brands/{brand}[/releases|/compare|/page],
// PUT /radar/settings, PUT|DELETE /radar/settings/exa-key (the key is kept but never answered),
// POST /radar/scan, GET|PUT /radar/brands, in the
// lambda/api/radar_handler.py wire shape ({success: false, error} on 400/404). Brands are the
// brand list (mock-radar-brands.js) then the legacy source-profile brands, merged by key.
// Stateful for the life of the mock process. Wired into mock-server.js by handleDomainModules.
// The reviews routes live in mock-radar-reviews.js.

import { brandListRoute, effectiveBrands } from './mock-radar-brands.js';
import { radarReview, radarReviews } from './mock-radar-reviews.js';

const CADENCES = ['daily', 'weekly', 'monthly'];
const DEFAULT_DAYS = 90;
const EXA_KEY = /^[A-Za-z0-9_-]{8,200}$/u;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const state = {
  settings: { cadence: 'weekly', max_brands: 10, query_cap: 30 },
  exaKey: null,
  lastScan: {
    status: 'completed', mode: 'scheduled', started_at: `${daysAgo(2)}T05:45:00Z`, finished_at: `${daysAgo(2)}T05:46:10Z`,
    brands: 1, queries: 6, added: 2, merged: 1,
  },
};

const brands = (shared) => effectiveBrands(shared);

const SENTIMENT = { positive: 14, negative: 9, neutral: 4, mixed: 1 };
/** A brand with its window totals, as the overview and /radar/all list it. */
const withTotals = (brand) => ({ ...brand, total: 28, avg_sentiment: 0.12, sentiment: SENTIMENT });

function trend(days) {
  return Array.from({ length: Math.min(days, 14) }, (_, i) => ({
    date: daysAgo(13 - i), count: 1 + (i % 4), avg_sentiment: Number((0.3 - (i % 5) * 0.12).toFixed(3)),
  }));
}

function detail(brand, days) {
  return {
    brand, days, total: 28, avg_sentiment: 0.12, sentiment: SENTIMENT, trend: trend(days), sampled: false,
    love: [
      { category: 'delivery', subcategory: 'speed', count: 8, quotes: ['Arrived a day early.', 'Fastest delivery I have had.'] },
      { category: 'product_quality', subcategory: null, count: 5, quotes: ['Sturdy and well made.'] },
    ],
    hate: [
      { category: 'customer_support', subcategory: 'response_time', count: 6, quotes: ['Waited a week for an answer.'] },
      { category: 'pricing', subcategory: null, count: 3, quotes: ['Too expensive for what it is.'] },
    ],
  };
}

/** One more news item of `brand`: a kind other than a release, found by web search, Exa or a feed. */
function newsItem(brand, { id, kind, via, ago, feature, url, title, official = true }) {
  return {
    release_id: id, brand: brand.key, brand_label: brand.label, feature, release_date: daysAgo(ago), date_approximate: false,
    summary: `${brand.label}: ${feature.toLowerCase()}.`, urls: [url], titles: [title],
    source_kind: official ? 'official' : 'third_party', mentions: 1,
    first_seen: `${daysAgo(ago)}T05:45:00Z`, last_seen: `${daysAgo(ago)}T05:45:00Z`, kind, found_via: via,
  };
}

function releases(brand) {
  const domain = brand.domains[0] ?? 'acme.example';
  return {
    brand, days: 365, releases: [
      {
        release_id: 'r1', brand: brand.key, brand_label: brand.label, feature: 'Same-day delivery in five more cities',
        release_date: daysAgo(12), date_approximate: false, summary: `${brand.label} extended same-day delivery to five more cities.`,
        urls: [`https://${domain}/news/same-day`, 'https://news.example.com/acme-same-day'],
        titles: ['Same-day delivery expands', 'Acme speeds up deliveries'], source_kind: 'official', mentions: 3,
        first_seen: `${daysAgo(11)}T05:45:00Z`, last_seen: `${daysAgo(2)}T05:45:00Z`, kind: 'release', found_via: ['web'],
      },
      newsItem(brand, { id: 'r3', kind: 'promotion', via: ['exa'], ago: 20, feature: 'Half-price first month on the premium plan',
        url: `https://${domain}/offers/premium`, title: 'Premium plan offer' }),
      newsItem(brand, { id: 'r4', kind: 'partnership', via: ['feed'], ago: 30, feature: 'Partnership with Example Air for lounge deliveries',
        url: `https://${domain}/news/example-air`, title: 'Working with Example Air' }),
      newsItem(brand, { id: 'r5', kind: 'announcement', via: ['web', 'exa'], ago: 35, feature: 'Opening a second warehouse',
        url: 'https://news.example.com/acme-warehouse', title: 'Acme opens a warehouse', official: false }),
      {
        release_id: 'r2', brand: brand.key, brand_label: brand.label, feature: 'Loyalty points on subscriptions',
        release_date: daysAgo(40), date_approximate: true, summary: 'Subscriptions now earn loyalty points, per press coverage.',
        urls: ['https://reviews.example.org/acme-loyalty'], titles: ['Acme adds loyalty points'], source_kind: 'third_party', mentions: 1,
        first_seen: `${daysAgo(40)}T05:45:00Z`, last_seen: `${daysAgo(40)}T05:45:00Z`, kind: 'news', found_via: ['web'],
      },
    ],
  };
}

function compare(brand, days) {
  const side = (volume, positive) => ({ volume, positive_share: positive, negative_share: Number((1 - positive - 0.1).toFixed(3)) });
  return {
    brand, days, ours_available: true, categories: [
      { category: 'delivery', theirs: side(10, 0.8), ours: side(42, 0.55), verdict: 'they_are_better' },
      { category: 'customer_support', theirs: side(8, 0.2), ours: side(30, 0.5), verdict: 'we_are_better' },
      { category: 'pricing', theirs: side(5, 0.4), ours: side(18, 0.44), verdict: 'even' },
    ],
  };
}

const RELEASE_FEED_CAP = 100;
const windowDays = (url) => Number(url.searchParams.get('days') ?? DEFAULT_DAYS) || DEFAULT_DAYS;

// GET /radar/all: every brand with its totals, and every brand's releases in the window,
// brand-tagged, newest first, capped like radar_handler (releases_capped / releases_total).
function allBrands(url, shared) {
  const days = windowDays(url);
  const since = daysAgo(days);
  const tagged = brands(shared).map((brand) => ({
    brand,
    releases: releases(brand).releases.filter((r) => r.release_date >= since)
      .map((release) => ({ ...release, brand: { key: brand.key, label: brand.label } })),
  }));
  const feed = tagged.flatMap((entry) => entry.releases).sort((a, b) => b.release_date.localeCompare(a.release_date));
  return [200, {
    days,
    brands: tagged.map(({ brand, releases: own }) => ({
      ...withTotals(brand),
      releases_in_window: own.length, latest_release: own[0] ?? null,
    })),
    releases: feed.slice(0, RELEASE_FEED_CAP), releases_total: feed.length, releases_capped: feed.length > RELEASE_FEED_CAP,
  }];
}

function putSettings(body) {
  const next = { ...state.settings, ...(body ?? {}) };
  const whole = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
  if (!CADENCES.includes(next.cadence)) return [400, { success: false, error: 'cadence must be one of daily, weekly, monthly' }];
  if (!whole(next.max_brands, 25)) return [400, { success: false, error: 'max_brands must be a whole number from 1 to 25' }];
  if (!whole(next.query_cap, 100)) return [400, { success: false, error: 'query_cap must be a whole number from 1 to 100' }];
  state.settings = { cadence: next.cadence, max_brands: next.max_brands, query_cap: next.query_cap };
  return [200, { success: true, settings: settingsView() }];
}

/** The settings as answered: the Exa key only as `exa_configured`. */
const settingsView = () => ({ ...state.settings, exa_configured: state.exaKey !== null });

function exaKeyRoute(method, body) {
  if (method === 'DELETE') {
    state.exaKey = null;
    return [200, { success: true, exa_configured: false }];
  }
  if (method !== 'PUT') return [405, { success: false, error: 'Method not allowed' }];
  const key = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
  if (!EXA_KEY.test(key)) return [400, { success: false, error: 'api_key must be 8-200 letters, digits, - or _' }];
  state.exaKey = key;
  return [200, { success: true, exa_configured: true }];
}

function startScan(body, shared) {
  const all = brands(shared);
  if (all.length === 0) return [400, { success: false, error: 'No Radar brand yet: add one in Administration → Sources → Radar first' }];
  const brand = body?.brand ?? null;
  if (brand !== null && !all.some((b) => b.key === brand)) return [404, { success: false, error: 'Radar brand not found' }];
  const stamp = new Date().toISOString();
  state.lastScan = { status: 'completed', mode: 'manual', started_at: stamp, finished_at: stamp, brands: brand ? 1 : all.length, queries: 6, added: 0, merged: 2 };
  return [202, { success: true, status: 'started', brand }];
}

function brandRoute(url, shared) {
  const match = url.pathname.match(/^\/radar\/brands\/([^/]+)(?:\/(releases|compare|page|reviews)(?:\/([^/]+))?)?$/u);
  if (!match) return null;
  const brand = brands(shared).find((b) => b.key === decodeURIComponent(match[1]));
  if (!brand) return [404, { success: false, error: 'Radar brand not found' }];
  if (match[3] !== undefined) return match[2] === 'reviews' ? radarReview(brand, decodeURIComponent(match[3])) : null;
  const days = windowDays(url);
  if (match[2] === 'reviews') return radarReviews(brand, url.searchParams, days);
  const view = {
    releases: () => releases(brand),
    compare: () => compare(brand, days),
    // The page's one read: the three views, releases over their own year (radar_handler.brand_page).
    page: () => ({ detail: detail(brand, days), releases: releases(brand), compare: compare(brand, days) }),
  }[match[2]] ?? (() => detail(brand, days));
  return [200, view()];
}

function route(req, url, body, shared) {
  if (url.pathname === '/radar/brands') return brandListRoute(req.method, body, shared);
  if (url.pathname === '/radar/settings/exa-key') return exaKeyRoute(req.method, body);
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /radar/all': return allBrands(url, shared);
    case 'GET /radar': return [200, { brands: brands(shared).map(withTotals), last_scan: state.lastScan, settings: settingsView() }];
    case 'PUT /radar/settings': return putSettings(body);
    case 'POST /radar/scan': return startScan(body, shared);
    default: break;
  }
  if (req.method === 'GET') return brandRoute(url, shared) ?? [404, { success: false, error: 'Not found' }];
  return [405, { success: false, error: 'Method not allowed' }];
}

/** Handle this module's routes; returns true when the request was taken. */
export function handleRadarRoutes(req, res, url, send, shared) {
  if (url.pathname !== '/radar' && !url.pathname.startsWith('/radar/')) return false;
  shared.collectJson(req, res, (body) => {
    const [status, payload] = route(req, url, body, shared);
    send(status, payload);
  });
  return true;
}
