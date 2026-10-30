// Dev-mock route for the Data Explorer's Data quality section, in the wire shape of
// lambda/api/metrics_handler.py `get_data_quality_metrics` (lambda/shared/data_quality.py):
//
//   GET /metrics/data-quality?days=…   {period_days, is_partial, sources: [{source, low, medium, high,
//                                       unrated, total}], overall: {low, medium, high, unrated, total}}
//
// Counted from the shared fixture feedback. The first request stamps a usefulness band on the fixtures
// (deterministic by position, cycling STAMP_CYCLE; `null` leaves an item unrated, as before a
// reprocess backfill), so the stamp lives for the process like every other fixture field.

const BANDS = ['low', 'medium', 'high'];
// The fixture set is small, so the cycle puts an unrated item second: the "Not rated" share shows.
const STAMP_CYCLE = ['high', null, 'low', 'medium'];
let stamped = false;

function stampBands(feedback) {
  if (stamped) return;
  stamped = true;
  feedback.forEach((item, index) => {
    const band = STAMP_CYCLE[index % STAMP_CYCLE.length];
    if (!item.usefulness && band) item.usefulness = band;
  });
}

function emptyRow(source) {
  return { source, low: 0, medium: 0, high: 0, unrated: 0, total: 0 };
}

function distribution(items) {
  const rows = new Map();
  for (const item of items) {
    const source = item.source_platform || 'unknown';
    const row = rows.get(source) ?? emptyRow(source);
    rows.set(source, row);
    row.total += 1;
    row[BANDS.includes(item.usefulness) ? item.usefulness : 'unrated'] += 1;
  }
  const sources = [...rows.values()].sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  const overall = { low: 0, medium: 0, high: 0, unrated: 0, total: 0 };
  for (const row of sources) for (const field of Object.keys(overall)) overall[field] += row[field];
  return { sources, overall };
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
