/**
 * The dev mock's feedback facets: `source`, `category`, `subcategory`, `sentiment` and
 * `usefulness`, each one value or a comma list meaning any of them (lambda/shared/item_facets.py).
 * `usefulness=unrated` admits a review stored without a band, and only then.
 *
 * `facetFilterOf` is folded into `attributeFilterOf` (mock-dimensions.js), so every list,
 * urgent, search, entities and problems route filters its fixtures by the same lists; with a
 * facet set, the metric routes count the filtered fixtures (`facetedMetric`) instead of
 * answering their static totals, so a filtered page shows filtered data.
 */

const MAX_FACET_VALUES = 50;
const MAX_FACET_VALUE_CHARS = 128;
const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'];
const BANDS = ['low', 'medium', 'high'];
const UNRATED = 'unrated';
const OTHER = 'other';

/** The fixture bands (`shared/usefulness.py` computes them on the server); absent = unscored. */
const SEED_BANDS = { 1: 'high', 2: 'low' };

export function seedUsefulness(feedback) {
  for (const item of feedback) {
    const band = SEED_BANDS[item.feedback_id];
    if (band) item.usefulness = band;
  }
}

function listOf(params, name, allowed) {
  const raw = params?.get(name);
  if (!raw) return { values: [] };
  const values = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  if (values.length > MAX_FACET_VALUES) return { error: `${name} accepts at most ${MAX_FACET_VALUES} values` };
  if (values.some((value) => value.length > MAX_FACET_VALUE_CHARS)) {
    return { error: `${name} values must be at most ${MAX_FACET_VALUE_CHARS} characters` };
  }
  if (allowed && values.some((value) => !allowed.includes(value))) {
    return { error: `${name} must be one or more of: ${allowed.join(', ')}` };
  }
  return { values };
}

const bandOf = (item) => (BANDS.includes(item.usefulness) ? item.usefulness : UNRATED);
// The mock knows no configuration here: `other` also admits a review with no category.
const categoryOf = (item) => item.category || OTHER;

/** `{admits(item), active}` for the facets of `params`, or `{error}` (a 400) for a malformed list. */
export function facetFilterOf(params) {
  const lists = {
    source: listOf(params, 'source'),
    category: listOf(params, 'category'),
    subcategory: listOf(params, 'subcategory'),
    sentiment: listOf(params, 'sentiment', SENTIMENTS),
    usefulness: listOf(params, 'usefulness', [...BANDS, UNRATED]),
  };
  const failed = Object.values(lists).find((list) => list.error);
  if (failed) return { error: failed.error };
  const { source, category, subcategory, sentiment, usefulness } = Object.fromEntries(
    Object.entries(lists).map(([name, list]) => [name, list.values]));
  const has = (values, value) => values.length === 0 || values.includes(value);
  return {
    active: Object.values(lists).some((list) => list.values.length > 0),
    lists: { source, category, subcategory, sentiment, usefulness },
    admits: (item) => has(source, item.source_platform) && has(category, categoryOf(item))
      && has(subcategory, item.subcategory) && has(sentiment, item.sentiment_label) && has(usefulness, bandOf(item)),
  };
}

/** `params` without `names` (the Problems tree shapes its own category / subcategory). */
export function withoutParams(params, names) {
  const copy = new URLSearchParams(params);
  for (const name of names) copy.delete(name);
  return copy;
}

const tallyBy = (items, keyOf) => items.reduce((acc, item) => {
  const key = keyOf(item);
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

function summaryOf(items, days) {
  const perDay = tallyBy(items, (item) => String(item.processed_at).slice(0, 10));
  const scores = items.map((item) => Number(item.sentiment_score) || 0);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  return {
    period_days: days, total_feedback: items.length, avg_sentiment: Math.round(avg * 1000) / 1000,
    urgent_count: items.filter((item) => item.urgency === 'high').length, is_partial: false,
    daily_totals: Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).map(([date, count]) => ({ date, count })),
    daily_sentiment: [],
  };
}

function sentimentOf(items, days) {
  const breakdown = Object.fromEntries(SENTIMENTS.map((label) => [label, 0]));
  for (const item of items) if (item.sentiment_label in breakdown) breakdown[item.sentiment_label] += 1;
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const percentages = Object.fromEntries(Object.entries(breakdown)
    .map(([label, n]) => [label, Math.round((n / Math.max(total, 1)) * 1000) / 10]));
  return { period_days: days, total, is_partial: false, breakdown, percentages };
}

const METRICS = {
  summary: summaryOf,
  sentiment: sentimentOf,
  categories: (items, days) => ({ period_days: days, is_partial: false, categories: tallyBy(items, categoryOf) }),
  sources: (items, days) => ({ period_days: days, is_partial: false, sources: tallyBy(items, (item) => item.source_platform || 'unknown') }),
};

/**
 * The `metric` route's answer over the filtered `items` when a facet is set, else null (the
 * route keeps its static fixture). `keepSingleCategory`: a lone `category` is the route's own
 * scope (the Categories gauge's `/metrics/sentiment?category=`), not a facet.
 */
/** The read routes' window when `days` is absent (shared.api effective_window_days); `0` stays all time. */
const DEFAULT_WINDOW_DAYS = 30;

export function facetedMetric(metric, params, items, { keepSingleCategory = false } = {}) {
  const filter = facetFilterOf(params);
  if (filter.error) return { __status: 400, body: { success: false, error: filter.error } };
  const { category, ...others } = filter.lists;
  const onlyOneCategory = category.length === 1 && Object.values(others).every((values) => values.length === 0);
  if (!filter.active || (keepSingleCategory && onlyOneCategory)) return null;
  const raw = params?.get('days');
  const days = raw === null || raw === undefined || raw.trim() === '' ? DEFAULT_WINDOW_DAYS : Number(raw);
  return METRICS[metric](items.filter(filter.admits), days);
}
