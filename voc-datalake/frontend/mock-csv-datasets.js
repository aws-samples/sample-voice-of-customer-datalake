/**
 * Dev mock of CSV dataset uploads (issue #411, docs/csv-import.md): the `csv-row-v2` identity,
 * the dry-run preview and confirmed in-place updates of `POST /scrapers/manual/csv-upload`.
 *
 * Mirrors `lambda/shared/csv_datasets.py` + `csv_dataset_plan.py`: a row with its own id,
 * uploaded under a dataset name, is keyed by (dataset, id); the next upload of that dataset
 * compares each row's content digest with the stored one (new / changed / unchanged), and a
 * row without an id (or an upload without a dataset) is a `v1_rows` row. Stateful for the
 * process lifetime: `datasetRows` maps `<source>|<row id>` to the mock feedback item it stored.
 */
import { createHash } from 'node:crypto';

const DATASET_NAME_MAX = 64;
const DATASET_NAME = /^[A-Za-z0-9 ._-]+$/;
const CHANGED_ROWS_LIMIT = 50;
const SNIPPET_LENGTH = 160;

/** `<source>|<row id>` -> the mock feedback item that row stored. */
const datasetRows = new Map();

const digest = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

/** `dataset_key`: `{key}` (null when none was given) or `{error}` for a 400. */
export function datasetKey(raw) {
  if (raw === undefined || raw === null) return { key: null };
  if (typeof raw !== 'string') return { error: 'dataset_name must be a string' };
  const name = raw.trim();
  if (!name) return { key: null };
  if (name.length > DATASET_NAME_MAX) return { error: `dataset_name must be at most ${DATASET_NAME_MAX} characters` };
  if (!DATASET_NAME.test(name)) return { error: 'dataset_name may contain only letters, digits, spaces, "-", "_" and "."' };
  return { key: name.replace(/ +/g, ' ').toLowerCase() };
}

/** The `csv-row-v2` id and content digest of a row with its own id (`fields`: the parsed columns). */
export function datasetIdentity(dataset, fields, rating, channel, metadata) {
  return {
    id: digest(['csv-row-v2', dataset, fields.id]),
    content_hash: digest(['csv-content-v1', fields.text, rating, fields.date ?? '', fields.author ?? '',
      fields.title ?? '', fields.url ?? '', channel, metadata ?? {}]),
    csv_dataset: dataset,
  };
}

const snippet = (text) => {
  const value = typeof text === 'string' ? text : '';
  return value.length <= SNIPPET_LENGTH ? value : `${value.slice(0, SNIPPET_LENGTH - 1)}…`;
};

/** `plan_dataset_rows`: `{new, changed: [{item, stored}], unchanged, v1_rows}`. */
export function planDataset(sourceId, items) {
  const plan = { new: [], changed: [], unchanged: [], v1_rows: [] };
  for (const item of items) {
    if (!item.content_hash) { plan.v1_rows.push(item); continue; }
    const stored = datasetRows.get(`${sourceId}|${item.id}`);
    if (!stored) plan.new.push(item);
    else if (stored.csv_content_hash === item.content_hash) plan.unchanged.push(item);
    else plan.changed.push({ item, stored });
  }
  return plan;
}

export const planCounts = (plan) => ({
  new: plan.new.length, changed: plan.changed.length, unchanged: plan.unchanged.length, v1_rows: plan.v1_rows.length,
});

/** The dry-run answer (`_csv_preview`). */
export function previewAnswer(plan, totalRows, warnings) {
  const shown = plan.changed.slice(0, CHANGED_ROWS_LIMIT);
  return {
    success: true, dry_run: true, total_rows: totalRows, counts: planCounts(plan),
    changed_rows: shown.map(({ item, stored }) => ({
      row: item.row, csv_row_id: item.csv_row_id || null, before: snippet(stored.original_text), after: snippet(item.text),
    })),
    changed_rows_truncated: plan.changed.length > shown.length,
    ...(warnings.length ? { warnings: warnings.slice(0, 20) } : {}),
  };
}

/** Remember the item a new `csv-row-v2` row stored, so the next upload of its dataset finds it. */
export function rememberDatasetRow(sourceId, item, stored) {
  if (!item.content_hash) return;
  stored.csv_dataset = item.csv_dataset;
  stored.csv_content_hash = item.content_hash;
  datasetRows.set(`${sourceId}|${item.id}`, stored);
}

/** Apply a confirmed correction in place (the processor's `refresh_csv_item`; dimensions / tags kept). */
export function applyDatasetUpdate({ item, stored }) {
  stored.original_text = item.text;
  stored.rating = item.rating;
  stored.csv_content_hash = item.content_hash;
  stored.source_refreshed_at = new Date().toISOString();
  if (item.dated) stored.source_created_at = item.created_at;
  for (const key of ['author', 'title']) {
    if (item[key]) stored[key] = item[key];
    else delete stored[key];
  }
}
