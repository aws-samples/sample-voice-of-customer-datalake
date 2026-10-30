// Import history mock (#237, docs/import-history.md): GET /scrapers/manual/history and
// GET /scrapers/manual/history/{run_id}, with the wire shape of lambda/shared/import_runs.py
// (`run_view`) and manual_import_handler.py's errors ({success: false, error}). Stateful for
// the life of the mock process: the paste confirm, CSV and JSON upload mocks in mock-sources.js
// call `recordImportRun`, so an import made in the dev UI shows up in the history table.
// Seeded with three runs (one per status) so the section is never empty on first load.
// Wired into mock-server.js by handleDomainModules; claims only its own two routes.

import { randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 300;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const HISTORY_PATH = '/scrapers/manual/history';
const DETAIL_PATH = /^\/scrapers\/manual\/history\/([^/]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOCK_ACTOR = { actor: 'mock-admin-sub', actor_email: 'admin@example.com' };

const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();
const fail = (status, error) => [status, { success: false, error }];

/** The first 200 messages, each at most 300 characters, and whether any was cut (import_runs._bounded). */
function bounded(messages) {
  const kept = messages.slice(0, MAX_MESSAGES).map(String)
    .map((m) => (m.length > MAX_MESSAGE_CHARS ? `${m.slice(0, MAX_MESSAGE_CHARS - 1)}…` : m));
  const cut = messages.length > MAX_MESSAGES || messages.some((m) => String(m).length > MAX_MESSAGE_CHARS);
  return { kept, cut };
}

/** import_runs.run_status: failed when nothing was imported, partial when rows failed. */
function runStatus(counts) {
  if (counts.imported <= 0) return 'failed';
  return counts.failed > 0 ? 'partial' : 'completed';
}

/** Newest first, like the real listing (sk `{started_at}#{run_id}`, ScanIndexForward false). */
const runs = [];

/** A CSV upload's counts from the rows its parser dropped, as manual_import_handler._csv_counts. */
export function csvUploadCounts(imported, { skipped, duplicate }) {
  return { received: imported + skipped + duplicate, imported, skipped, duplicate };
}

/**
 * Record one import, as `shared.import_runs.record_import_run` does.
 * `run`: {method, source, source_id?, counts: {received, imported, skipped?, duplicate?, failed?},
 * warnings?, errors?, raw_s3_key?, radar_brand?, started_at?, actor?, actor_email?}.
 */
export function recordImportRun(run) {
  const counts = { received: 0, imported: 0, skipped: 0, duplicate: 0, failed: 0, ...run.counts };
  const warnings = bounded(run.warnings ?? []);
  const errors = bounded(run.errors ?? []);
  const now = new Date().toISOString();
  const record = {
    run_id: run.run_id ?? randomUUID(), method: run.method, source: run.source, source_id: run.source_id ?? 'manual_import',
    actor: run.actor ?? MOCK_ACTOR.actor, actor_email: run.actor_email ?? MOCK_ACTOR.actor_email,
    started_at: run.started_at ?? now, finished_at: run.finished_at ?? now, counts, status: runStatus(counts),
    warning_count: (run.warnings ?? []).length, error_count: (run.errors ?? []).length,
    truncated: warnings.cut || errors.cut, raw_s3_key: run.raw_s3_key ?? null, radar_brand: run.radar_brand ?? null,
    warnings: warnings.kept, errors: errors.kept,
  };
  runs.push(record);
  runs.sort((a, b) => `${b.started_at}#${b.run_id}`.localeCompare(`${a.started_at}#${a.run_id}`));
  return record.run_id;
}

recordImportRun({
  run_id: '7d3c2b1a-0f9e-4d8c-b7a6-5e4d3c2b1a09',
  method: 'csv', source: 'Example Air survey', started_at: isoAgo(2 * DAY_MS), finished_at: isoAgo(2 * DAY_MS - 4000),
  counts: { received: 412, imported: 398, skipped: 9, duplicate: 5 },
  warnings: [
    ...Array.from({ length: 9 }, (_, i) => `row ${i * 37 + 4}: empty text — skipped`),
    ...Array.from({ length: 5 }, (_, i) => `row ${i * 61 + 12}: duplicate row — skipped`),
    'row 88: rating is not a number — left blank',
  ],
  raw_s3_key: 's3://voc-raw-data-123456789012-us-west-2/raw/csv_upload/2026/10/01/mock.csv',
});
recordImportRun({
  method: 's3', source: 'S3 - reviews_export', source_id: 's3_import', actor: 's3-upload', actor_email: '',
  started_at: isoAgo(DAY_MS), finished_at: isoAgo(DAY_MS - 9000),
  counts: { received: 250, imported: 200, failed: 50 }, errors: ['stopped after 200 items: SQS rejected 1 message(s)'],
  raw_s3_key: 's3://voc-s3-import-123456789012-us-west-2/reviews_export/june_reviews.csv',
});
recordImportRun({
  method: 'assistant', source: 'Example Air forum', started_at: isoAgo(3 * 3_600_000), finished_at: isoAgo(3 * 3_600_000 - 800),
  counts: { received: 12, imported: 12 },
});

/** A run as the list answers it: everything but the message lists (import_runs.run_view). */
function summary(run) {
  const view = { ...run };
  delete view.warnings;
  delete view.errors;
  return view;
}

function parseLimit(raw) {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^-?\d+$/.test(raw)) return null;
  return Math.max(1, Math.min(MAX_LIMIT, Number(raw)));
}

/** GET /scrapers/manual/history?limit=&cursor= — the cursor is opaque (here: the next offset). */
function listRuns(url) {
  const limit = parseLimit(url.searchParams.get('limit'));
  const cursor = url.searchParams.get('cursor') ?? '';
  const offset = cursor === '' ? 0 : Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (limit === null || !Number.isInteger(offset) || offset < 0) return fail(400, 'limit or cursor is not valid');
  const page = runs.slice(offset, offset + limit).map(summary);
  const next = offset + limit < runs.length ? Buffer.from(String(offset + limit)).toString('base64url') : null;
  return [200, { runs: page, next_cursor: next }];
}

function getRun(runId) {
  const run = UUID.test(runId) ? runs.find((r) => r.run_id === runId) : undefined;
  return run ? [200, { run: structuredClone(run) }] : fail(404, 'Import run not found');
}

export function handleImportHistoryRoutes(req, _res, url, send) {
  if (req.method !== 'GET') return false;
  if (url.pathname === HISTORY_PATH) {
    send(...listRuns(url));
    return true;
  }
  const match = DETAIL_PATH.exec(url.pathname);
  if (!match) return false;
  send(...getRun(decodeURIComponent(match[1])));
  return true;
}
