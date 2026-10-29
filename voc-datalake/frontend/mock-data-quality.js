// Dev-mock route for the Data Explorer's Data quality section, in the wire shape of
// lambda/api/metrics_handler.py `get_data_quality_metrics` (lambda/shared/data_quality.py):
//
//   GET /metrics/data-quality?days=…   {period_days, is_partial, sources: [{source, low, medium, high,
//                                       unrated, total}], overall: {low, medium, high, unrated, total}}
//
// Counted from the shared fixture feedback. The first request stamps a usefulness band on the fixtures
// (deterministic by position; every UNRATED_EVERY-th item stays unrated, as before a reprocess
// backfill), so the stamp lives for the process like every other fixture field.

const BANDS = ['low', 'medium', 'high'];
const UNRATED_EVERY = 4;
// A rough stand-in for lambda/shared/usefulness.py: longer fixture text rates higher.
const WORDS_PER_BAND = 8;
let stamped = false;

function stampBands(feedback) {
  if (stamped) return;
  stamped = true;
  feedback.forEach((item, index) => {
    if (item.usefulness || index % UNRATED_EVERY === UNRATED_EVERY - 1) return;
    const words = String(item.original_text || '').split(/\s+/).filter(Boolean).length;
    item.usefulness = BANDS[Math.min(Math.floor(words / WORDS_PER_BAND), BANDS.length - 1)];
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

function dataQuality(url, shared) {
  stampBands(shared.mockFeedback);
  const days = Number(url.searchParams.get('days'));
  if (url.searchParams.has('days') && (!Number.isInteger(days) || days < 0 || days > 9999)) {
    return [400, { success: false, message: 'days must be an integer between 0 and 9999' }];
  }
  return [200, { period_days: days || 30, is_partial: false, ...distribution(shared.mockFeedback) }];
}

/** Handle this module's route; returns true when the request was taken. */
export function handleDataQualityRoutes(req, res, url, send, shared) {
  if (url.pathname !== '/metrics/data-quality') return false;
  if (req.method !== 'GET') send(405, { success: false, error: 'Method not allowed' });
  else send(...dataQuality(url, shared));
  return true;
}
