// Radar reviews mock (docs/radar.md): GET /radar/brands/{brand}/reviews in the
// lambda/api/radar_handler.py wire shape: {brand, reviews, next_cursor, limit}, newest first,
// filtered by days / category / subcategory ('' = none) / sentiment / day, paged by an
// opaque base64url cursor (400 when it does not decode); and GET /radar/brands/{brand}/reviews/{id}
// (one review with its enrichment, 404 when absent). Used by mock-radar.js.

const SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'];
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

// The same themes as the mock's love / hate lists, so a theme click finds its reviews.
const THEMES = [
  ['delivery', 'speed', 'positive', 0.8, 'Arrived a day early and well packed.'],
  ['customer_support', 'response_time', 'negative', -0.7, 'Waited a week for an answer to a simple question.'],
  ['product_quality', null, 'positive', 0.6, 'Sturdy and well made, it feels like it will last.'],
  ['pricing', null, 'negative', -0.5, 'Too expensive for what it is.'],
  ['delivery', 'speed', 'mixed', 0.1, 'Fast, but the box was crushed on arrival.'],
  ['customer_support', null, 'neutral', 0, 'Support answered, nothing more to say.'],
];
const LONG_TAIL = ' I have ordered from them for years and this is how it usually goes, which is why I keep coming back even when the price is higher than elsewhere.'.repeat(3);

function review(brand, i) {
  const [category, subcategory, sentiment, score, text] = THEMES[i % THEMES.length];
  return {
    feedback_id: `${brand.key}-r${String(i).padStart(2, '0')}`,
    day: daysAgo(i < 36 ? Math.floor(i / 3) : 40 + i),
    title: i % 4 === 0 ? `Review ${i + 1}` : undefined,
    text: i % 7 === 0 ? `${text}${LONG_TAIL}` : text,
    quote: text,
    rating: i % 3 === 0 ? 1 + (i % 5) : undefined,
    sentiment_label: sentiment, sentiment_score: score, category, subcategory,
    problem_summary: sentiment === 'negative' ? `Customers complain about ${category.replace('_', ' ')}.` : undefined,
    source_platform: 'competitor_reviews',
    source_url: i % 2 === 0 ? `https://reviews.example.com/${brand.key}/${i}` : undefined,
  };
}

// The stored sort key, `{radar_day}#{feedback_id}`.
const sortKey = (item) => `${item.day}#${item.feedback_id}`;

// Newest first, like the month partitions read in descending sort-key order.
const fixtures = (brand) => Array.from({ length: 42 }, (_, i) => review(brand, i))
  .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

const encode = (item) => Buffer.from(JSON.stringify({ sk: sortKey(item) })).toString('base64url');

function decode(cursor) {
  try {
    const sk = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).sk;
    return typeof sk === 'string' ? sk : null;
  } catch {
    return null;
  }
}

function matches(item, params, since) {
  const sub = params.get('subcategory');
  return item.day >= since
    && (!params.get('category') || item.category === params.get('category'))
    && (sub === null || (item.subcategory ?? '') === sub)
    && (!params.get('sentiment') || item.sentiment_label === params.get('sentiment'))
    && (!params.get('day') || item.day === params.get('day'));
}

function invalid(params) {
  const sentiment = params.get('sentiment');
  if (sentiment && !SENTIMENTS.includes(sentiment)) return 'sentiment must be one of positive, negative, neutral, mixed';
  const day = params.get('day');
  if (day && !DAY.test(day)) return 'day must be a YYYY-MM-DD date';
  const cursor = params.get('cursor');
  return cursor && decode(cursor) === null ? 'cursor is not valid' : null;
}

/** [status, payload] for GET /radar/brands/{brand}/reviews. */
export function radarReviews(brand, params, days) {
  const error = invalid(params);
  if (error) return [400, { success: false, error }];
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(params.get('limit') ?? '', 10) || DEFAULT_LIMIT));
  const after = params.get('cursor') ? decode(params.get('cursor')) : null;
  const since = daysAgo(days - 1);
  const rest = fixtures(brand).filter((item) => matches(item, params, since)
    && (after === null || sortKey(item) < after));
  const page = rest.slice(0, limit);
  const next = rest.length > limit ? encode(page[page.length - 1]) : null;
  const reviews = page.map((item) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)));
  return [200, { brand, reviews, next_cursor: next, limit }];
}

const DETAIL = {
  persona_name: 'Busy parent', persona_type: 'value_seeker', journey_stage: 'post_purchase', impact_area: 'retention',
  source_channel: 'web', language: 'en',
};

/** [status, payload] for GET /radar/brands/{brand}/reviews/{feedback_id}: never author or email. */
export function radarReview(brand, feedbackId) {
  const item = fixtures(brand).find((candidate) => candidate.feedback_id === feedbackId);
  if (!item) return [404, { success: false, error: 'Radar review not found' }];
  const hypothesis = item.sentiment_label === 'negative' ? { problem_root_cause_hypothesis: 'Too few support agents at peak times.' } : {};
  const review = Object.fromEntries(Object.entries({ ...item, ...DETAIL, ...hypothesis, source_created_at: `${item.day}T10:00:00Z` })
    .filter(([, value]) => value !== undefined));
  return [200, { brand: { key: brand.key, label: brand.label }, review }];
}
