# Import History

Every import writes one **run record**: who imported what, from which file, how many rows landed,
and the warnings and errors the import returned. Administrators read the records in the
**Import history** section at the bottom of the Data sources page (`/scrapers`), and through two
admin-only API routes. Records are kept for **90 days**.

The record is the audit trail only. Re-processing a run (#144) and deleting a run's data (#143)
are separate features; both can target a run once it has an id.

## What writes a record

| Entry point | Method | Source label | Actor |
|---|---|---|---|
| `POST /scrapers/manual/confirm` (paste a review page, then confirm) | `paste` | the detected origin (`g2`, a domain) | the caller's Cognito sub and email |
| `POST /scrapers/manual/csv-upload` | `csv` | the upload's `default_source` (default `csv_upload`) | the caller |
| `POST /scrapers/manual/json-upload` | `json` | the source profile id (`manual_import` by default) | the caller |
| The AI assistant's `import_reviews` (it calls json-upload with `import_origin: 'assistant'`) | `assistant` | the source name the user gave (`source_label`, at most 120 characters, control characters removed; the profile id when blank) | the approving user |
| A file dropped in the S3 import bucket (`plugins/s3_import`), one record per file | `s3` | `S3 - <folder>` | `s3-upload` (the bucket trigger does not know who uploaded the file) |

On json-upload the `assistant` method and its label are **client-reported**: the route records
what the request says (`import_origin`, `source_label`) and cannot verify that the AI assistant sent
it. Read them as an audit hint, not proof; the actor and the archived raw file are what the server
knows. A `source_label` without `import_origin: 'assistant'` is ignored.

Warnings and errors never quote a cell or field value (a rating cell can hold review text or an email
address, and the record outlives the source's retention and erasure): they name the row, the column
and the reason only. An S3 import's parse error names the error class, or for an unreadable JSON file the
line and column. Rows are numbered the same way everywhere: data rows from 1, the header not counted.

A request refused with a 400 (no `text` column, a JSON item without an id, a file over the size
limit on the REST routes) imports nothing and writes no record: the response is the whole outcome.
An S3 file that is empty, over 50 MB, or cannot be parsed at all writes a `failed` record with the
reason, because nobody sees a response for it. A file with an unsupported extension writes nothing.

## The record

| Field | Meaning |
|---|---|
| `run_id` | A UUID. For CSV and JSON uploads it is also the name of the archived raw file (`raw/csv_upload/…/{run_id}.csv`). |
| `method` | `paste`, `csv`, `json`, `s3` or `assistant` |
| `source`, `source_id` | The label above, and the source profile the rows were filed under |
| `actor`, `actor_email` | Cognito sub and email of the caller; `s3-upload` and an empty email for the bucket trigger |
| `started_at`, `finished_at` | ISO 8601, UTC |
| `counts` | `received` (rows in the input), `imported` (accepted by the processing queue), `skipped` (empty text, a parse error, or dropped by the source's PII policy), `duplicate` (the same row twice in one CSV), `failed` (rows the queue refused) |
| `status` | `partial` when some rows failed and others were imported; `failed` when rows failed and none was imported, or when nothing was imported and the run recorded an error (an unreadable, empty or oversized file); else `completed`. Skipped and duplicate rows are expected and each carries a warning, so a file whose rows were all skipped (or that has no data rows) is `completed` with 0 imported. |
| `warnings`, `errors` | Detail only. At most 200 of each, each at most 300 characters; `warning_count` / `error_count` are the full counts and `truncated` is true when anything was cut |
| `raw_s3_key` | The archived input (`s3://…`), which has every row; empty when the source policy keeps no raw file (redaction, summary-only, or a retention period) |
| `radar_brand` | Set when the upload went to a [Radar](radar.md) brand instead of our own feedback |

A CSV upload's response shows the first 20 warnings; the record keeps up to 200.

## Storage

In `voc-aggregates`, two rows per run, both with `ttl` = 90 days after the run finished:

| pk | sk | Holds |
|---|---|---|
| `IMPORT_RUN` | `{started_at}#{run_id}` | The summary: every field except `warnings` and `errors`, so the newest-first listing reads small rows |
| `IMPORT_RUN#{run_id}` | `RUN` | The detail: the summary fields plus `warnings` and `errors` |

The detail row is written first, so a listed run always has a detail. One partition holds every
summary row; imports are a few per day, far below a partition's write limit. DynamoDB deletes
expired rows up to a few days late; the routes hide a row past its `ttl`.

Writing the record never fails an import. A DynamoDB error is logged as a warning
(`Import run record not written`) and the import answers as before. The writer is
`lambda/shared/import_runs.py`, shared by the manual-import Lambda and the S3 import ingestor
(both already held read/write access to `voc-aggregates`; no IAM change).

## API

Both routes are on the manual-import Lambda and admin-only (its module middleware, like every
`/scrapers/manual/*` route).

| Method | Path | Answer |
|---|---|---|
| GET | `/scrapers/manual/history?limit=&cursor=` | `{runs: [summary…], next_cursor}`, newest first; `limit` 1-100 (default 25); pass `next_cursor` back as `cursor` for the next page. 400 for a non-numeric `limit` or a cursor from elsewhere |
| GET | `/scrapers/manual/history/{run_id}` | `{run: detail}`; 404 when the run is unknown or expired |

## Not included, and why

- **Feedback-form submissions.** Each submission is already its own stored record, readable at
  `GET /feedback-forms/{id}/submissions`; one run record per submission would duplicate it.
- **Scheduled plugin runs and scraper runs.** They are collection, not imports, and already have
  their own run rows: `SOURCE_RUN#{source}` (manual "Run now" of a plugin) and `SCRAPER_RUN#{id}`
  (`GET /scrapers/{id}/status`, latest run only).

Possible follow-ups: show plugin and scraper runs in the same history, keep more than the latest
scraper run, stamp `run_id` on each imported feedback item so "which run created these records" is
one lookup (today it is the raw file for CSV and JSON uploads, and `manual_import_job_id` for pastes),
and record who uploaded an S3 file (the presigned upload could carry the uploader as object metadata).
