// Mock caller scope: what GET /feedback/access says the (single) mock caller may see,
// and the restricted view of the reads that show categories, counts and names
// (owner rule 2026-10-21: a restricted caller sees only their categories).
//
// Default: unrestricted (the dev caller is an admin). Two ways to narrow it:
//   - start the mock with MOCK_RESTRICT_CATEGORIES=customer_support (a comma list),
//     or MOCK_RESTRICT_CATEGORIES=none for a caller whose access covers no category;
//   - while it runs: curl -X PUT localhost:3001/__mock/scope -d '{"categories":["technical_support"]}'
//     (`[]` = no category, `null` = unrestricted again); GET /__mock/scope reads it back.
//     Reload the page afterwards (the SPA caches the scope for 10 minutes).
// Fixture choices: `customer_support` has reviews; `technical_support` is configured but
// has none (the "allowed categories, nothing arrived" state).
//
// While restricted, like metrics_handler / settings_handler for a viewer:
//   GET /feedback/access        → {all: false, categories, default source rule}
//   GET /settings/categories    → only the allowed categories
//   GET /feedback*, /feedback/urgent, /feedback/entities, /feedback/{id} → only their items
//   GET /metrics/categories     → only their counters
//   GET /metrics/summary|sentiment|sources|personas → the fixture scaled to their share
// The SPA's own admin bypass (useIsAdmin in a DEV build without Cognito) is unchanged;
// the UI treats a restricted scope as "cannot set up" on its own.
// Wired into mock-server.js; the dev-only /__mock/scope route is not an app route.

const ROUTE = '/__mock/scope';

/** The env value as a category list: unset → null (unrestricted), `none` → []. */
function parseRestriction(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (raw.trim() === 'none') return [];
  return raw.split(',').map((name) => name.trim()).filter(Boolean);
}

const state = { categories: parseRestriction(process.env.MOCK_RESTRICT_CATEGORIES) };

export const isScopeRestricted = () => state.categories !== null;
export const scopeAdmits = (name) => state.categories === null || state.categories.includes(name);

/** GET /feedback/access as the real route answers it (metrics_handler.get_feedback_access). */
export function callerAccess() {
  if (state.categories === null) {
    return { all: true, categories: [], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] };
  }
  // A restricted viewer is not an admin: the default source rule, nothing denied in the fixtures.
  return {
    all: false, categories: [...state.categories].sort((a, b) => a.localeCompare(b)),
    sources_all: false, sources: [], source_rule: 'deny', sources_denied: [],
  };
}

/** The categories config a viewer receives (settings_handler._redacted_categories). */
export function scopedCategoriesConfig(config) {
  if (state.categories === null) return config;
  return { ...config, categories: config.categories.filter((c) => scopeAdmits(c.name)) };
}

const sumOf = (counts) => Object.values(counts).reduce((total, n) => total + n, 0);

/** The allowed categories' share of all reviews in the category fixture (1 when unrestricted). */
function shareOf(categoryCounts) {
  const total = sumOf(categoryCounts);
  if (state.categories === null || total === 0) return 1;
  const allowed = Object.entries(categoryCounts).filter(([name]) => scopeAdmits(name));
  return sumOf(Object.fromEntries(allowed)) / total;
}

const scaled = (n, share) => Math.round(n * share);

function scaleCounts(counts, share) {
  const entries = Object.entries(counts ?? {}).map(([key, n]) => [key, scaled(n, share)]).filter(([, n]) => n > 0);
  return Object.fromEntries(entries);
}

function scaleSummary(summary, share) {
  if (share === 0) return { ...summary, total_feedback: 0, avg_sentiment: 0, urgent_count: 0, daily_totals: [], daily_sentiment: [] };
  const days = (rows) => rows.map((row) => ({ ...row, count: scaled(row.count, share) }));
  return {
    ...summary,
    total_feedback: scaled(summary.total_feedback, share),
    urgent_count: scaled(summary.urgent_count, share),
    daily_totals: days(summary.daily_totals ?? []),
    daily_sentiment: days(summary.daily_sentiment ?? []),
  };
}

/**
 * Counts scaled to `share` that still add up to the scaled total (largest
 * remainder), so a page that compares a breakdown with its total — Categories'
 * "Uncategorised" row — never shows a rounding difference as real reviews.
 */
function scaleBreakdown(counts, share) {
  const exact = Object.entries(counts).map(([key, n]) => ({ key, value: n * share }));
  const target = Math.round(exact.reduce((total, { value }) => total + value, 0));
  const floored = exact.map(({ key, value }) => ({ key, base: Math.floor(value), rest: value - Math.floor(value) }));
  const missing = target - floored.reduce((total, { base }) => total + base, 0);
  const bumped = new Set([...floored].sort((a, b) => b.rest - a.rest).slice(0, missing).map(({ key }) => key));
  return Object.fromEntries(floored.map(({ key, base }) => [key, base + (bumped.has(key) ? 1 : 0)]));
}

function scaleSentiment(sentiment, share) {
  const breakdown = scaleBreakdown(sentiment.breakdown, share);
  const total = sumOf(breakdown);
  const percentages = Object.fromEntries(Object.entries(breakdown)
    .map(([k, n]) => [k, Math.round((n / Math.max(total, 1)) * 1000) / 10]));
  return { ...sentiment, total, breakdown, percentages };
}

const SCALERS = {
  'GET /metrics/summary': scaleSummary,
  'GET /metrics/sentiment': scaleSentiment,
  'GET /metrics/sources': (body, share) => ({ ...body, sources: scaleCounts(body.sources, share) }),
};

/**
 * A handler's 200 body as a restricted caller receives it. `categoryCounts` is the
 * `/metrics/categories` fixture the shares are taken from; `searchParams` tells a
 * category-scoped sentiment read (already per category) from a global one.
 */
export function scopedMetric(key, body, { categoryCounts, searchParams }) {
  if (state.categories === null || body === null || typeof body !== 'object') return body;
  if (key === 'GET /metrics/categories') {
    const allowed = Object.entries(body.categories ?? {}).filter(([name]) => scopeAdmits(name));
    return { ...body, categories: Object.fromEntries(allowed) };
  }
  if (key === 'GET /metrics/sentiment' && searchParams?.get('category')) {
    return scopeAdmits(searchParams.get('category')) ? body : scaleSentiment(body, 0);
  }
  const scale = SCALERS[key];
  return scale ? scale(body, shareOf(categoryCounts)) : body;
}

/** A PUT body's restriction, or an error message. */
function restrictionOf(body) {
  const value = body?.categories;
  if (value === null) return { categories: null };
  if (Array.isArray(value) && value.every((name) => typeof name === 'string' && name.trim() !== '')) {
    return { categories: value.map((name) => name.trim()) };
  }
  return { error: 'categories must be null (unrestricted) or a list of category names ([] = none)' };
}

/** GET|PUT /__mock/scope: read or change the mock caller's scope at runtime. */
export function handleScopeRoutes(req, res, url, send, shared) {
  if (url.pathname !== ROUTE) return false;
  if (req.method === 'GET') {
    send(200, { categories: state.categories });
    return true;
  }
  if (req.method !== 'PUT') {
    send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const next = restrictionOf(body);
    if (next.error) {
      send(400, { success: false, error: next.error });
      return;
    }
    state.categories = next.categories;
    send(200, { categories: state.categories });
  });
  return true;
}
