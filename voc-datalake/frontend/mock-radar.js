// Radar mock (docs/radar.md): GET /radar, GET /radar/brands/{brand}[/releases|/compare],
// GET|PUT /radar/settings, POST /radar/scan, GET|PUT /radar/brands, in the
// lambda/api/radar_handler.py wire shape ({success: false, error} on 400/404). Brands are the
// brand list (mock-radar-brands.js) then the legacy source-profile brands, merged by key.
// Stateful for the life of the mock process. Wired into mock-server.js by handleDomainModules.
// The reviews routes live in mock-radar-reviews.js.

import { brandListRoute, effectiveBrands } from './mock-radar-brands.js';
import { radarReview, radarReviews } from './mock-radar-reviews.js';

const CADENCES = ['daily', 'weekly', 'monthly'];
const DEFAULT_DAYS = 90;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const state = {
  settings: { cadence: 'weekly', max_brands: 10, query_cap: 30 },
  lastScan: {
    status: 'completed', mode: 'scheduled', started_at: `${daysAgo(2)}T05:45:00Z`, finished_at: `${daysAgo(2)}T05:46:10Z`,
    brands: 1, queries: 6, added: 2, merged: 1,
  },
};

const brands = (shared) => effectiveBrands(shared);

const SENTIMENT = { positive: 14, negative: 9, neutral: 4, mixed: 1 };

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

function releases(brand) {
  const domain = brand.domains[0] ?? 'acme.example';
  return {
    brand, days: 365, releases: [
      {
        release_id: 'r1', brand: brand.key, brand_label: brand.label, feature: 'Same-day delivery in five more cities',
        release_date: daysAgo(12), date_approximate: false, summary: `${brand.label} extended same-day delivery to five more cities.`,
        urls: [`https://${domain}/news/same-day`, 'https://news.example.com/acme-same-day'],
        titles: ['Same-day delivery expands', 'Acme speeds up deliveries'], source_kind: 'official', mentions: 3,
        first_seen: `${daysAgo(11)}T05:45:00Z`, last_seen: `${daysAgo(2)}T05:45:00Z`,
      },
      {
        release_id: 'r2', brand: brand.key, brand_label: brand.label, feature: 'Loyalty points on subscriptions',
        release_date: daysAgo(40), date_approximate: true, summary: 'Subscriptions now earn loyalty points, per press coverage.',
        urls: ['https://reviews.example.org/acme-loyalty'], titles: ['Acme adds loyalty points'], source_kind: 'third_party', mentions: 1,
        first_seen: `${daysAgo(40)}T05:45:00Z`, last_seen: `${daysAgo(40)}T05:45:00Z`,
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

function putSettings(body) {
  const next = { ...state.settings, ...(body ?? {}) };
  const whole = (value, max) => Number.isInteger(value) && value >= 1 && value <= max;
  if (!CADENCES.includes(next.cadence)) return [400, { success: false, error: 'cadence must be one of daily, weekly, monthly' }];
  if (!whole(next.max_brands, 25)) return [400, { success: false, error: 'max_brands must be a whole number from 1 to 25' }];
  if (!whole(next.query_cap, 100)) return [400, { success: false, error: 'query_cap must be a whole number from 1 to 100' }];
  state.settings = { cadence: next.cadence, max_brands: next.max_brands, query_cap: next.query_cap };
  return [200, { success: true, settings: state.settings }];
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
  const match = url.pathname.match(/^\/radar\/brands\/([^/]+)(?:\/(releases|compare|reviews)(?:\/([^/]+))?)?$/u);
  if (!match) return null;
  const brand = brands(shared).find((b) => b.key === decodeURIComponent(match[1]));
  if (!brand) return [404, { success: false, error: 'Radar brand not found' }];
  if (match[3] !== undefined) return match[2] === 'reviews' ? radarReview(brand, decodeURIComponent(match[3])) : null;
  const days = Number(url.searchParams.get('days') ?? DEFAULT_DAYS) || DEFAULT_DAYS;
  if (match[2] === 'reviews') return radarReviews(brand, url.searchParams, days);
  const view = { releases: () => releases(brand), compare: () => compare(brand, days) }[match[2]] ?? (() => detail(brand, days));
  return [200, view()];
}

function route(req, url, body, shared) {
  const total = (brand) => ({ ...brand, total: 28, avg_sentiment: 0.12, sentiment: SENTIMENT });
  if (url.pathname === '/radar/brands') return brandListRoute(req.method, body, shared);
  switch (`${req.method} ${url.pathname}`) {
    case 'GET /radar': return [200, { brands: brands(shared).map(total), last_scan: state.lastScan, settings: state.settings }];
    case 'GET /radar/settings': return [200, { settings: state.settings }];
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
