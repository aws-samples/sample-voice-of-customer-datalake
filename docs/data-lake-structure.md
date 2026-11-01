# Data Lake Structure

The platform keeps every ingested item twice: the raw item as a JSON file in S3, and the enriched
item in DynamoDB. DynamoDB also holds the pre-computed metrics, settings, projects, jobs, assistant
conversations and the state of the other features. This document is for operators and developers
who need to find, inspect or repair stored data: the S3 layout, the tables and their keys, the
Data Explorer, the S3 import bucket and what is retained. How items get there is in
[Processing Pipeline](processing-pipeline.md).

## S3 Raw Data Structure

Raw feedback is partitioned by source and by the item's own date (`created_at`, or the archive
time when the item has none):

```
s3://voc-raw-data-<account>-<region>/
└── raw/
    └── {source_platform}/
        └── {year}/{month}/{day}/{item_id}.json
```

Example paths:

```
raw/webscraper/2026/01/08/abc123def456.json
raw/feedback_form/2026/01/08/uuid-here.json
```

The file name derives from the item's source id (or a hash of its date, text and URL), so ingesting
the same item again overwrites the same object. A source whose PII policy is `redact` or
`summary_only` keeps no raw copy ([source-policies.md](source-policies.md)).

The raw envelope written by ingestors and webhooks (`plugins/_shared/raw_archive.py`) is:

```json
{
  "item_id": "abc123def456",
  "source_platform": "webscraper",
  "ingested_at": "2026-01-08T10:30:00Z",
  "partition_date": "2026-01-08",
  "raw_content": "Original API response (optional)",
  "raw_item": {
    "id": "original_source_id",
    "text": "The feedback content",
    "rating": 4.5,
    "created_at": "2026-01-07T15:00:00Z",
    "url": "https://source.example/review/123",
    "author": "Example reviewer"
  }
}
```

The bucket is versioned and KMS-encrypted. Ingestor roles may only put objects under `raw/`: they
cannot read or delete. Only `voc-retention` deletes raw objects, for an opt-in per-source retention
period or an erasure request. The Data Explorer (admin-only) can create a new object but refuses
(409) to overwrite an existing key under `raw/`. An overwritten object's previous version is kept
for 90 days. Deleting the stack empties the bucket (every version) and deletes it; back up first
([Deployment → Teardown](deployment.md#teardown-deletes-everything-back-up-first)).

Other prefixes in the same bucket store project uploads, extracted product context, persona avatars
(`avatars/<project_id>/<persona_id>.png`) and generated prototype assets. `scratch/` holds working
copies of research and document workflows and expires after 2 days.

## DynamoDB Tables

All tables use on-demand capacity and customer-managed KMS encryption. Physical names are
`[<deploymentPrefix>-]<base>-<account>-<region>`.

| Table (base name) | Primary key | Purpose |
|-------|-------------|---------|
| `voc-feedback` | `pk=SOURCE#<brand_name, else source_platform>`, `sk=FEEDBACK#<id>` | Processed feedback and enrichment. Producers send the deployment's brand name, so most items share one partition; filter by `source_platform` to select a source. Its stream feeds the aggregator |
| `voc-aggregates` | `pk`, `sk` | Daily metrics, settings, logs, form configs, source and scraper runs, prioritization rows, ballots and voting sessions |
| `voc-watermarks` | `source` (`<plugin_id>#<key>`) | Per-source ingestion progress |
| `voc-projects` | `pk`, `sk` | Project metadata, personas, artifacts, document comments and review links, global MCP tokens (`MCPGTOKEN`), and managed-version state |
| `voc-jobs` | `pk=PROJECT#<id>`, `sk=JOB#<id>` | Long-running research and generation jobs, and assist jobs |
| `voc-conversations` | `pk=USER#<subject>`, `sk=CONV#<id>` | Per-user AI assistant sessions (`kind=assistant`; `messages_json`/`page_json`/`pending_json` JSON strings, `message_count`, item kept under ~350 KB) and legacy chat records (native `messages` list); current writes do not set TTL |
| `voc-idempotency` | `id` | Processor and aggregator retry claims |
| `voc-memory` | `pk`, `sk` | Company and personal memory ([memory.md](memory.md)) |
| `voc-agents` | `pk`, `sk` | Agents, workflows, runs and assistant plans ([autonomous-agents.md](autonomous-agents.md)) |
| `voc-radar` | `pk`, `sk` | Other brands' reviews, kept out of your own metrics ([radar.md](radar.md)) |
| `voc-participants` | `pk`, `sk` | People to ask for feedback, lists and asks ([participants.md](participants.md)) |
| `voc-feature-requests` | `pk`, `sk` | Feedback boards and their requests ([feature-requests.md](feature-requests.md)) |

### Feedback table indexes

| Index | Partition key | Sort key | Use case |
|-------|---------------|----------|----------|
| `gsi1-by-date` | `gsi1pk = DATE#<processing date>` | `gsi1sk = <processing timestamp>#<id>` | Date-window queries |
| `gsi2-by-category` | `gsi2pk = CATEGORY#<category>` | `gsi2sk = <sentiment score>#<timestamp>` | Category queries |
| `gsi3-by-urgency` | `gsi3pk = URGENCY#<urgency>` | `gsi3sk = <timestamp>` | Urgent-item queries (slim projection) |
| `gsi4-by-feedback-id` | `feedback_id` | — | Direct lookup independent of source partition |
| `gsi5-by-channel` | `source_channel` | `gsi1sk` (processing time) | Channel-filtered lists and metrics; slim projection (`CHANNEL_INDEX_FIELDS` in `lambda/shared/channel_index.py`), so a small channel in a big import is read without reading the whole day |

The date index is keyed by when the processor stored the item, not by the review's own date.

Feedback items do not expire: the table has no TTL and the processor stamps none. Only
`voc-retention` deletes feedback, when a source profile sets `retention_days` or an administrator
requests an erasure ([source-policies.md](source-policies.md)). Deployments that predate this carry a legacy `ttl` on old items until `scripts/retention/remove_ttl.py --apply` removes it (see [Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted)). Category corrections (`category_source='manual'`, `category_override`) and reprocessing (`category_source='reprocess'`) update items in place; see [Categories](categories.md).

### Aggregates table

The index `gsi1-by-metric-type` (`metric_type`, `pk`) finds the metric partitions of one kind,
such as every source or persona counter. Common key families include:

| Key pattern | Purpose |
|-------------|---------|
| `METRIC#*` | Pre-computed daily counters and averages |
| `METRIC#meta` / `earliest_date`, `data_version`, `config_version` | Earliest-data watermark used by all-time (`days=0`) windows, and the cache version counters ([caching.md](caching.md)) |
| `SETTINGS#*` | Brand, categories (with product and owners), dimensions, source profiles and model configuration |
| `CATEGORY_ACCESS` / `USER#<sub>` | Which categories and sources a user may see (no row = all) |
| `JOB#category_reprocess` / `rp_<hex>` | Category reprocess jobs |
| `JOB#erasure` / `er_<hex>`, `AUDIT#retention` | Erasure jobs and the retention audit trail |
| `LOGS#validation#<source>`, `LOGS#processing#<source>` | Validation and processing logs (7-day TTL) |
| `FEEDBACK_FORM` | Feedback-form configuration and statistics |
| `SOURCE_RUN#<source>` / `<execution id>` | Manual and reprocess runs of a plugin ingestor |
| `SCRAPER_RUN#<scraper id>` | Scraper run state |
| `CIRCUIT#<plugin>` / `TRIPPED`, `FAILURES#<plugin>` | Plugin circuit breaker ([plugin-architecture.md](plugin-architecture.md#circuit-breaker)) |
| `IMPORT_RUN`, `IMPORT_RUN#<run id>` | Import history (90-day TTL, [import-history.md](import-history.md)) |
| `PRIORITIZATION` / `ROW#<id>` | Prioritization rows ([prioritization.md](prioritization.md)) |

Metric rows are kept indefinitely (no `ttl`). The table keeps TTL enabled for its operational rows (logs, circuit-breaker failures, import history, voting sessions). Settings and other durable configuration rows omit TTL. See [Processing Pipeline](processing-pipeline.md#rebuilding-aggregates-for-a-window) before repairing counters.

### Projects table

A project uses `pk=PROJECT#<project_id>`. Its sort keys include `META`, `PERSONA#<id>`, managed artifact prefixes such as `PRD#`, `PRFAQ#`, and `PROTOTYPE#`, and uploaded `DOC#` rows. The index `gsi1-by-type` lists items of one type, such as every project.

PRDs, PR/FAQs, and prototypes have internal version state in a separate partition:

```
pk = DOCUMENT_VERSIONS#PROJECT#<project_id>
sk = <DOCUMENT_TYPE>#<title-digest>                 # series counter
sk = ALLOCATION#<DOCUMENT_TYPE>#<allocation-digest> # durable allocation history
```

These rows preserve monotonic version numbers and retry identity. They deliberately survive document deletion; deleting or rewriting them can make delayed retries conflict or reuse version numbers. Manage artifacts through the application/API, not by deleting internal rows directly.

### Jobs, conversations, and idempotency

- Job rows use TTL (`ttl`). Completed and failed jobs remain available briefly for progress and diagnostics; assist jobs expire after 1 day. The index `gsi1-by-status` lists jobs by status.
- Conversations are partitioned by authenticated user. Although the table has a `ttl` attribute configured, current conversation writes omit it, so rows persist until explicitly deleted or the stack is destroyed.
- Two writers share an assistant conversation item: the SPA (`POST /chat/conversations/{id}`) and the stream Lambda, which saves the conversation while a run streams (user turn + in-progress answer, `run_id`, `run_status` running/finished/failed/interrupted/stopped, `revision`). A reload mid-answer therefore finds the partial answer and the SPA polls until it finishes. The server owns a run's answer: an SPA save is refused (409) while the run is live (last write < 960 s ago) or when its `baseRevision` is older than the stored `revision`. The stream Lambda's role holds only `GetItem`/`PutItem` on the table; it always writes the verified caller's own partition. Stop in the assistant writes a separate marker item `pk USER#{sub}`, `sk RUNCANCEL#{conversation id}` (`run_id`, `ttl` one day) through `POST /chat/conversations/{id}/cancel`; the running stream Lambda polls it (GetItem every 1.5 s), stops generating and saves the partial answer as `stopped`. The conversation list reads `CONV#` keys only, so the marker never lists.
- Idempotency rows use the `expiration` TTL attribute. Processor and aggregator keys share the table but use distinct namespaces.

## Data Explorer

The Data Explorer browses the raw-data bucket and edits selected S3 or feedback records. It is an operational/debugging surface, not a replacement for project and version APIs. It is **admin-only** on every route (raw S3 cannot be filtered by category access), and it cannot delete: there is no DELETE route at API Gateway and its role holds no delete permission.

Folders read by name, the stored key staying the row's tooltip: the top folders and source folders by their label, and an avatar folder (`avatars/<persona id>`) by the persona and when it was made, "Persona 2 · Oct 24, 2026, 12:34 PM" (`persona_<stamp>_<hex>_<index>`), or "Persona · Oct 24, 2026, 12:34 PM" for an id without a batch index (an imported persona, or an id from before the random suffix).

### API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/data-explorer/buckets` | List available logical buckets |
| GET | `/data-explorer/s3` | List S3 objects |
| GET | `/data-explorer/s3/preview` | Preview file content |
| PUT | `/data-explorer/s3` | Create a file, optionally reprocess it (409 when overwriting an existing `raw/` key) |
| PUT | `/data-explorer/feedback` | Update a feedback record in place |

## S3 Import Bucket

The S3 import bucket (`voc-import-<account>-<region>`, `VocIngestionStack` output
`S3ImportBucketName`) is a staging bucket, separate from the raw data lake. A `.csv`, `.json` or
`.jsonl` file uploaded under `<source>/` triggers the `s3_import` ingestor, which queues each row for
processing under the source `S3 - <source>`. The bucket is versioned (an overwrite or delete is
recoverable for 7 days), staged files expire 90 days after upload, and `processed/` is reserved
(moved to Glacier after 30 days). Administrators use the file explorer on the **S3 Bulk Import**
card in **Administration → Sources → Source settings**. Its API (`s3_import_handler.py`) is
**admin-only on every route**, because an upload ingests its rows into the pipeline and the listings
expose the bucket name and every staged file.

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| GET | `/s3-import/sources` | Admin | List source folders (never `processed`) and the bucket name |
| POST | `/s3-import/sources` | Admin | Create a source folder (`[A-Za-z0-9_-]`) |
| GET | `/s3-import/files` | Admin | List `.csv` / `.json` / `.jsonl` files (`?source=`, `?include_processed=true`) |
| POST | `/s3-import/upload-url` | Admin | Presign a create-only PUT for `<source>/<file>`: 409 when the key holds a file, and the URL is signed with `If-None-Match: *` (S3 answers 412 to an overwrite). The PUT must send the returned `upload_headers`. To replace a file, delete it first |
| DELETE | `/s3-import/file/{key}` | Admin | Delete one staged file. 400 unless the key is exactly `<source>/<file.csv\|.json\|.jsonl>`: no leading `/`, no `..`, never `processed/` |
| POST | `/s3-import/reprocess` | Admin | Re-run one file through the `s3_import` ingestor, body `{key}` → **202** `{success, run}`. The key is `<source>/<file>` (validated as for delete) or `processed/<source>/<file>`; 400 for any other key, an empty file or one over the ingestor's 50 MB limit, 404 when the key holds nothing |
| GET | `/s3-import/reprocess/{run_id}` | Admin | One reprocess run `{run: {run_id, key, status: running\|completed\|error, items_found, started_at, completed_at, errors}}`; 404 when unknown |

### Reprocessing a file

Ingested files stay where they were uploaded: the ingestor never moves or deletes them, so a file
listed in the explorer can be run through the pipeline again (the **Reprocess** action on each file
in the S3 Bulk Import explorer). Use it to recover rows after a partial
processing failure, or to restore rows after an accidental erasure.

- **Same code path as an upload.** The API async-invokes the ingestor with the S3 trigger's own event
  shape (one `ObjectCreated` record for the key) plus `execution_id` and `reprocess: true`.
- **Duplicates are skipped.** The processor derives a feedback id from the source and the row (the
  row's `id` column, else a hash of its text), not from the import time, and skips an id it already
  holds before any Bedrock or Comprehend call. Only rows missing from the data lake are imported again.
- **The source label must match.** That id includes the folder-derived source `S3 - <folder>`. A copy
  archived by hand as `processed/<folder>/<file>` is reprocessed as `S3 - <folder>`, like its original
  upload (an S3 upload event under `processed/` still gets `S3 - processed`). A file moved to ANOTHER
  folder is a new source, and its rows are imported as new feedback.
- **Stored rows are not re-enriched.** To re-categorize feedback that is already stored, use
  *Reprocess existing feedback* in Administration → Taxonomy (`POST /settings/categories/reprocess`).
- **The run is a source run.** `POST /s3-import/reprocess` writes `SOURCE_RUN#s3_import` / `<run id>`
  (`running`) in the aggregates table, and the ingestor moves it to `completed` (with `items_found`,
  the rows sent to the processing queue, duplicates included) or `error` (the exception type only).
  `GET /sources/status?run_status=s3_import` and the assistant's `get_source_run` read the same rows.
  The S3 import API role may read and write only that partition (`dynamodb:LeadingKeys`) and invoke
  only the `s3_import` ingestor. Without the plugin enabled, the route answers "not configured".
- **One live run per file (409).** A second `POST /s3-import/reprocess` for a file answers **409**
  ("This file is already being reprocessed") while a `running` run of that file started less than the
  ingestor's timeout ago (300 s, `infrastructure.ingestor.timeout` in `plugins/s3_import/manifest.json`;
  `INGESTOR_TIMEOUT_SECONDS` in `lambda/shared/s3_import_runs.py`). A finished run, or one still
  `running` but older than that (it timed out without closing its row), does not block. Two requests in
  the same instant can both start; that is harmless, because duplicates are skipped.
- **Only the import bucket is read.** The ingestor reads a record only when it names the bucket in its
  `S3_IMPORT_BUCKET` environment variable (set by `VocIngestionStack`, the bucket of the S3 trigger). A
  record for any other bucket is skipped with a warning, unread, because the API invokes the ingestor
  directly and the event's bucket is not trusted. A reprocess that reads no file this way ends `error`
  (`NoImportFileRead`), never `completed` with 0 rows. Its role's S3 grant is read/write on the import
  bucket only (and its KMS key).
- **Retries.** An upload's S3 event keeps Lambda's default 2 async retries, its only automatic recovery
  from a transient failure. A reprocess that fails is NOT retried: the ingestor closes the run `error`
  and returns instead of raising, so the row the explorer stopped polling never moves back to
  `running`. Press Reprocess again; the rows already queued are skipped as duplicates. A reprocess
  whose invocation crashes or times out (no `error` written) is still retried by Lambda under the same
  run id, and its `started_at` moves to the retry.
- **Raw archive.** A row is archived under a key derived from its id and its date, so a re-run
  overwrites the same object; a row with no date is archived under the day of the re-run.

## Data Flow

```
External source → Ingestor/API → S3 raw archive → SQS → Processor → Feedback table
                                                           │
                                                           └→ DynamoDB Stream → Aggregates
Projects UI/API → Jobs → Bedrock → Projects table + S3 artifact assets
```

## Retention

Customer data is not deleted while the platform runs, apart from opt-in per-source retention and erasure requests ([Source policies](source-policies.md)). Deleting the stacks deletes all of it; back up first ([Deployment → Teardown](deployment.md#teardown-deletes-everything-back-up-first)). Details and the migration for existing deployments: [Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted).

- **S3 raw data:** kept under `raw/` while the platform runs, unless a source's retention or an erasure removes it; previous versions of overwritten objects are kept 90 days; the bucket is deleted with the stack. Project assets in the same bucket are managed by the project APIs.
- **Feedback:** no expiry unless a source profile sets `retention_days`; the table is deleted with the stack.
- **Daily aggregate metrics:** no expiry; the table is deleted with the stack.
- **Projects:** no expiry; the table is deleted with the stack.
- **Processing logs:** seven-day TTL.
- **Jobs and idempotency:** item-specific TTL appropriate to progress visibility or retry guarantees.
- **Conversations:** no automatic expiry on current writes; delete through the application/API when no longer needed.

## Querying Feedback

Use indexes rather than scans. For example, the items processed on one day come from `gsi1-by-date`:

```python
response = table.query(
    IndexName='gsi1-by-date',
    KeyConditionExpression='gsi1pk = :pk',
    ExpressionAttributeValues={':pk': 'DATE#2026-01-08'},
)
```

Use the application APIs where possible: they enforce authorization, pagination ceilings, partial-window reporting, and project tombstones that a direct table read bypasses.
