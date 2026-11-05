// Feedback boards as their own evidence source (docs/feature-requests.md), in the wire shape of
// the board Insights and search routes served by the engagement API:
//
//   GET  /feature-requests/insights?board=&days=   (days 0–3650, 0 = all)
//        -> {success, board: {id, label} | null, window_days, totals: {requests, supporters, enriched},
//            truncated, top (≤ 20, by supporters), by_category (null = uncategorized), by_status,
//            by_sentiment ('unknown' = not enriched)}
//   POST /feature-requests/insights/enrich {board?}  (admin)  -> {success, queued, remaining}
//   GET  /feature-requests/search?q=&board=&category=&status=&days=&limit=  -> {success, items, total, truncated}
//
// Reached through mock-feature-requests.js, which hands these paths here BEFORE its own
// `/feature-requests/{id}` pattern could read `insights` or `search` as a request id. The requests come
// from that module's store (only the boards the viewer may see); the mock's enrich "answers" at once,
// filing a fixed category and sentiment on up to ENRICH_PAGE requests per call. Never mixed into the
// review metrics of mock-server.js.

const INSIGHTS = '/feature-requests/insights';
const ENRICH = '/feature-requests/insights/enrich';
const SEARCH = '/feature-requests/search';
const MAX_DAYS = 3650;
const TOP_LIMIT = 20;
const ENRICH_PAGE = 2;
const DAY_MS = 86_400_000;

const fail = (status, error) => [status, { success: false, error }];

/** A whole-number query parameter in [min, max], `fallback` when absent; null when malformed. */
function intParam(url, name, { min, max, fallback }) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

const listParam = (url, name) => (url.searchParams.get(name) ?? '').split(',').map((value) => value.trim()).filter(Boolean);

const inWindow = (meta, days) => days === 0 || Date.parse(meta.created_at) >= Date.now() - days * DAY_MS;
const supportersOf = (meta) => meta.totals?.supporters ?? 0;
const categoryOf = (meta) => meta.enrichment?.category ?? null;

/** `{key, requests, supporters}` rows of `metas` grouped by `keyOf`, busiest first. */
function groupBy(metas, keyOf) {
  const rows = new Map();
  for (const meta of metas) {
    const key = keyOf(meta);
    const row = rows.get(key) ?? { key, requests: 0, supporters: 0 };
    row.requests += 1;
    row.supporters += supportersOf(meta);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.requests - a.requests || b.supporters - a.supporters);
}

function insights(url, viewer, entriesFor) {
  const days = intParam(url, 'days', { min: 0, max: MAX_DAYS, fallback: 90 });
  if (days === null) return fail(400, `days must be a whole number from 0 to ${MAX_DAYS}`);
  const boardRef = url.searchParams.get('board') || undefined;
  const { entries, board } = entriesFor(viewer, boardRef);
  const metas = entries.map((entry) => entry.meta).filter((meta) => inWindow(meta, days));
  const top = [...metas].sort((a, b) => supportersOf(b) - supportersOf(a)).slice(0, TOP_LIMIT).map((meta) => ({
    request_id: meta.request_id, board_id: meta.board_id, title: meta.title, status: meta.status,
    supporters: supportersOf(meta), category: categoryOf(meta),
  }));
  return [200, {
    success: true,
    board: board ? { id: board.board_id, label: board.name } : null,
    window_days: days,
    // The mock reads every request, so it never stops at a budget.
    truncated: false,
    totals: {
      requests: metas.length,
      supporters: metas.reduce((sum, meta) => sum + supportersOf(meta), 0),
      enriched: metas.filter((meta) => meta.enrichment?.status === 'ok').length,
    },
    top,
    by_category: groupBy(metas, categoryOf).map(({ key, ...row }) => ({ category: key, ...row })),
    by_status: groupBy(metas, (meta) => meta.status).map(({ key, ...row }) => ({ status: key, ...row })),
    // A request not enriched yet (or with no sentiment) is the server's 'unknown' bucket.
    by_sentiment: groupBy(metas, (meta) => meta.enrichment?.sentiment ?? 'unknown').map(({ key, requests }) => ({ sentiment: key, requests })),
  }];
}

function enrich(body, viewer, entriesFor) {
  if (!viewer.is_admin) return fail(403, 'Only an admin can do that');
  const boardRef = typeof body.board === 'string' && body.board !== '' ? body.board : undefined;
  const pending = entriesFor(viewer, boardRef).entries.filter((entry) => entry.meta.enrichment === undefined);
  const page = pending.slice(0, ENRICH_PAGE);
  for (const entry of page) {
    entry.meta.enrichment = {
      status: 'ok', category: 'feature_request', subcategory: null, sentiment: 'neutral',
      problem_summary: entry.meta.title, language: 'en', model_id: 'mock', prompt_version: 'mock-1',
      text_sha16: '0000000000000000', enriched_at: new Date().toISOString(),
    };
  }
  return [200, { success: true, queued: page.length, remaining: pending.length - page.length }];
}

const slim = (meta) => ({
  request_id: meta.request_id, board_id: meta.board_id, title: meta.title, description: (meta.description ?? '').slice(0, 1000),
  status: meta.status, supporters: supportersOf(meta), category: categoryOf(meta),
  sentiment: meta.enrichment?.sentiment ?? null, problem_summary: meta.enrichment?.problem_summary ?? null, created_at: meta.created_at,
});

function matchesSearch(meta, { q, categories, statuses, boards, days }) {
  const haystack = `${meta.title} ${meta.description ?? ''}`.toLowerCase();
  return (q === '' || haystack.includes(q))
    && (categories.length === 0 || categories.includes(categoryOf(meta)))
    && (statuses.length === 0 || statuses.includes(meta.status))
    && (boards.length === 0 || boards.includes(meta.board_id))
    && (days === undefined || inWindow(meta, days));
}

function search(url, viewer, entriesFor) {
  const limit = intParam(url, 'limit', { min: 1, max: 100, fallback: 25 });
  const days = intParam(url, 'days', { min: 0, max: MAX_DAYS, fallback: undefined });
  if (limit === null || days === null) return fail(400, 'limit must be 1–100 and days 0–3650');
  const filters = {
    q: (url.searchParams.get('q') ?? '').trim().toLowerCase(), categories: listParam(url, 'category'),
    statuses: listParam(url, 'status'), boards: listParam(url, 'board'), days,
  };
  const found = entriesFor(viewer, undefined).entries.map((entry) => entry.meta).filter((meta) => matchesSearch(meta, filters))
    .sort((a, b) => supportersOf(b) - supportersOf(a));
  return [200, { success: true, items: found.slice(0, limit).map(slim), total: found.length, truncated: found.length > limit }];
}

/** The route this module owns for `req`, or null. */
function ownRoute(req, url) {
  if (url.pathname === INSIGHTS && req.method === 'GET') return 'insights';
  if (url.pathname === ENRICH && req.method === 'POST') return 'enrich';
  if (url.pathname === SEARCH && req.method === 'GET') return 'search';
  return [INSIGHTS, ENRICH, SEARCH].includes(url.pathname) ? 'method' : null;
}

const HANDLERS = {
  insights: (url, _body, viewer, entriesFor) => insights(url, viewer, entriesFor),
  enrich: (_url, body, viewer, entriesFor) => enrich(body, viewer, entriesFor),
  search: (url, _body, viewer, entriesFor) => search(url, viewer, entriesFor),
  method: () => fail(405, 'Method not allowed'),
};

/**
 * Handle this module's routes; returns true when the request was taken. `entriesFor(viewer, boardRef)`
 * answers `{entries, board}`: the store entries of one board (`boardRef`) or of every board the viewer
 * may see, and the board itself; it throws the boards module's Refusal for a board the viewer cannot see.
 */
export function handleFeatureRequestInsightRoutes(req, res, url, send, shared, { viewer, entriesFor, onRefusal }) {
  const route = ownRoute(req, url);
  if (route === null) return false;
  shared.collectJson(req, res, (raw) => {
    const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    try {
      send(...HANDLERS[route](url, body, viewer, entriesFor));
    } catch (error) {
      send(...onRefusal(error));
    }
  });
  return true;
}
