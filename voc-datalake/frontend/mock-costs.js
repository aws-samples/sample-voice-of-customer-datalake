// Cost per workspace in the dev mock (7.83.00), in the wire shape of lambda/api/workspaces_handler.py
// `GET /platform/costs` and lambda/shared/platform_costs.py `cost_page` (docs/multi-workspace.md, "Cost per workspace"):
//   GET /platform/costs?from=&to=&limit=&cursor=  → {estimate: true, label, currency, price_as_of, price_source, from,
//       to, workspaces: [{id, name, slug, status, days, total}], next_cursor} and, on the first page (no cursor),
//       `deployment` (with `deleted_workspaces`) and `unattributed`
// Platform admins only (403 otherwise); 400 for a range the server refuses (`to` after today, `from` after `to`, over
// 92 days) or a bad limit or cursor. The figures are made up and fixed per workspace and day: one priced model, and on
// Juniper Trail Co.'s even days an unpriced one too (its days and total incomplete), so the page shows both.

const COSTS_ROUTE = '/platform/costs';
const ESTIMATE_LABEL = 'Estimate from list prices, not a bill';
const MAX_RANGE_DAYS = 92;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 25;
const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PRICED = 'model-alpha';
const UNPRICED = 'model-beta';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const msOf = (day) => Date.parse(`${day}T00:00:00Z`);
const usd = (micros) => (micros / 1e6).toFixed(6);

/** The range of `?from=&to=` as parse_range reads it, or a 400's error. */
function rangeOf(url) {
  const today = dayOf(Date.now());
  const to = url.searchParams.get('to') || today;
  const from = url.searchParams.get('from') || `${to.slice(0, 7)}-01`;
  if (!DAY.test(to) || Number.isNaN(msOf(to))) return { refusal: 'to must be a date (YYYY-MM-DD)' };
  if (!DAY.test(from) || Number.isNaN(msOf(from))) return { refusal: 'from must be a date (YYYY-MM-DD)' };
  if (to > today) return { refusal: 'to must not be after today (UTC)' };
  if (from > to) return { refusal: 'from must not be after to' };
  if ((msOf(to) - msOf(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) return { refusal: `the range is at most ${MAX_RANGE_DAYS} days` };
  return { from, to };
}

/** One sum's public shape (`_Sum.public`): counts, the priced part's dollars, complete, the unpriced models. */
function sum(calls, micros, unpriced) {
  const complete = unpriced.length === 0;
  // (nothing priced and nothing unpriced: a known zero)
  const priced = micros === null && complete ? 0 : micros;
  return {
    calls, input_tokens: calls * 900, output_tokens: calls * 120, cache_read_tokens: calls * 40, cache_write_tokens: 0,
    estimated_usd: priced === null ? null : usd(priced), complete, unpriced_models: [...unpriced],
  };
}

/** An entity's days with calls (`seed` sets how many and how much) and its total, as `summary` answers them. */
function summary(seed, from, to, { unpricedOnEvenDays = false } = {}) {
  const days = [];
  for (let ms = msOf(from); ms <= msOf(to); ms += DAY_MS) {
    const date = dayOf(ms);
    const n = Number(date.slice(8, 10));
    if ((n + seed) % 3 === 0) continue;
    const calls = ((n * seed) % 7) + 1;
    const unpriced = unpricedOnEvenDays && n % 2 === 0 ? [UNPRICED] : [];
    days.push({ date, ...sum(calls + unpriced.length, calls * 1250 * seed, unpriced) });
  }
  const calls = days.reduce((total, day) => total + day.calls, 0);
  const micros = days.reduce((total, day) => total + Math.round(Number(day.estimated_usd) * 1e6), 0);
  const unpriced = [...new Set(days.flatMap((day) => day.unpriced_models))].sort();
  const total = sum(calls, days.length === 0 ? null : micros, unpriced);
  const line = { model_id: PRICED, service_tier: 'default', ...sum(calls, days.length === 0 ? null : micros, []) };
  return { days, total: { ...total, by_model: days.length === 0 ? [] : [line] } };
}

/** `GET /platform/costs`, platform admins only; true when the request was taken. */
export function handleCostRoutes(req, res, url, send, shared, context) {
  if (url.pathname !== COSTS_ROUTE || req.method !== 'GET') return false;
  shared.collectJson(req, res, () => {
    if (!context.isPlatformAdmin()) return send(403, { success: false, error: 'Platform admin access required' });
    const range = rangeOf(url);
    if (range.refusal) return send(400, { success: false, error: range.refusal });
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null || limitText === '' ? DEFAULT_LIMIT : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return send(400, { success: false, error: `limit must be a whole number from 1 to ${MAX_LIMIT}` });
    }
    const cursor = url.searchParams.get('cursor');
    const start = cursor === null || cursor === '' ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0) return send(400, { success: false, error: 'cursor is not valid' });
    const listed = context.workspaces();
    const rows = listed.slice(start, start + limit).map((workspace, index) => ({
      id: workspace.id, name: workspace.name, slug: workspace.slug, status: workspace.status,
      ...summary(start + index + 2, range.from, range.to, { unpricedOnEvenDays: workspace.slug === 'juniper' }),
    }));
    const body = {
      estimate: true, label: ESTIMATE_LABEL, currency: 'USD', price_as_of: '2026-11-16',
      price_source: 'https://aws.amazon.com/bedrock/pricing/', from: range.from, to: range.to, workspaces: rows,
      next_cursor: start + limit < listed.length ? String(start + limit) : null,
    };
    if (start === 0) {
      body.deployment = { ...summary(1, range.from, range.to), deleted_workspaces: sum(0, null, []) };
      body.unattributed = summary(5, range.from, range.to);
    }
    return send(200, body);
  });
  return true;
}
