// Dev-mock route for the Data Explorer's Data quality section, in the wire shape of
// lambda/api/metrics_handler.py `get_data_quality_metrics` (lambda/shared/data_quality.py):
//
//   GET /metrics/data-quality?days=…   {period_days, is_partial, sources: [{source, low, medium, high,
//                                       unrated, total, profile}], overall: {…, profile}}
//
// `profile` (lambda/shared/source_profile.py) is {profiled, rating: {1..5, none}, sentiment: {positive,
// neutral, negative, mixed, other}, length: {short, medium, long, very_long}}, bucketed like the API. The
// mock leaves every fourth fixture unprofiled, so the "not profiled" note shows.
//
// Counted from the shared fixture feedback. The first request stamps a usefulness band on the fixtures
// (deterministic by position, cycling STAMP_CYCLE; `null` leaves an item unrated, as before a
// reprocess backfill), so the stamp lives for the process like every other fixture field.

const BANDS = ['low', 'medium', 'high'];
// The fixture set is small, so the cycle puts an unrated item second: the "Not rated" share shows.
const STAMP_CYCLE = ['high', null, 'low', 'medium'];
let stamped = false;

/** Stamp the fixture bands once; mock-server.js calls it at startup so a filtered page never changes later. */
export function stampBands(feedback) {
  if (stamped) return;
  stamped = true;
  feedback.forEach((item, index) => {
    const band = STAMP_CYCLE[index % STAMP_CYCLE.length];
    if (!item.usefulness && band) item.usefulness = band;
  });
}

const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'];

/** A fixture's position from its numeric feedback id; the list position when the id is not a number. */
function stableIndex(item, fallback) {
  const id = Number(item.feedback_id);
  return Number.isInteger(id) ? id : fallback;
}
const LENGTH_BOUNDS = [[50, 'short'], [200, 'medium'], [1000, 'long']];

function emptyProfile() {
  return {
    profiled: 0,
    rating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, none: 0 },
    sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0, other: 0 },
    length: { short: 0, medium: 0, long: 0, very_long: 0 },
  };
}

function ratingBucket(raw) {
  const value = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(value) || value <= 0 || value > 5) return 'none';
  return String(Math.max(Math.round(value), 1));
}

function profileValues(item) {
  const label = item.sentiment_label ?? 'neutral';
  const size = typeof item.original_text === 'string' ? item.original_text.length : 0;
  return {
    rating: ratingBucket(item.rating),
    sentiment: SENTIMENTS.includes(label) ? label : 'other',
    length: (LENGTH_BOUNDS.find(([bound]) => size < bound) ?? [0, 'very_long'])[1],
  };
}

function addProfile(profile, item) {
  profile.profiled += 1;
  for (const [facet, value] of Object.entries(profileValues(item))) profile[facet][value] += 1;
}

function sumProfiles(profiles) {
  const total = emptyProfile();
  for (const profile of profiles) {
    total.profiled += profile.profiled;
    for (const facet of ['rating', 'sentiment', 'length']) {
      for (const value of Object.keys(total[facet])) total[facet][value] += profile[facet][value];
    }
  }
  return total;
}

function emptyRow(source) {
  return { source, low: 0, medium: 0, high: 0, unrated: 0, total: 0, profile: emptyProfile() };
}

function distribution(items) {
  const rows = new Map();
  items.forEach((item, index) => {
    const source = item.source_platform || 'unknown';
    const row = rows.get(source) ?? emptyRow(source);
    rows.set(source, row);
    row.total += 1;
    row[BANDS.includes(item.usefulness) ? item.usefulness : 'unrated'] += 1;
    // Stored "before the profile counters existed": a fixed quarter of the fixtures (by feedback id, so
    // which ones does not move with the filters), so the note shows.
    if (stableIndex(item, index) % 4 !== 1) addProfile(row.profile, item);
  });
  const sources = [...rows.values()].sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  const overall = { low: 0, medium: 0, high: 0, unrated: 0, total: 0 };
  for (const row of sources) for (const field of Object.keys(overall)) overall[field] += row[field];
  return { sources, overall: { ...overall, profile: sumProfiles(sources.map((row) => row.profile)) } };
}

// The handler's window (shared/api.py `effective_window_days`): absent = 30 days; `0` (all time) =
// the data's history, a year when there is no earliest-data date, as for these fixtures.
const DEFAULT_DAYS = 30;
const ALL_TIME_FALLBACK_DAYS = 365;

function periodDays(url) {
  if (!url.searchParams.has('days')) return DEFAULT_DAYS;
  const days = Number(url.searchParams.get('days'));
  return days === 0 ? ALL_TIME_FALLBACK_DAYS : days;
}

function dataQuality(url, shared) {
  stampBands(shared.mockFeedback);
  const days = Number(url.searchParams.get('days'));
  if (url.searchParams.has('days') && (!Number.isInteger(days) || days < 0 || days > 9999)) {
    return [400, { success: false, message: 'days must be an integer between 0 and 9999' }];
  }
  return [200, { period_days: periodDays(url), is_partial: false, ...distribution(shared.mockFeedback) }];
}

/** Handle this module's route; returns true when the request was taken. */
export function handleDataQualityRoutes(req, res, url, send, shared) {
  if (url.pathname !== '/metrics/data-quality') return false;
  if (req.method !== 'GET') send(405, { success: false, error: 'Method not allowed' });
  else send(...dataQuality(url, shared));
  return true;
}
