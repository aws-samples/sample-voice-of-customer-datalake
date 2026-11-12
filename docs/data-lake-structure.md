# Data Lake Structure

The platform keeps every ingested item twice: the raw item as a JSON file in S3, and the enriched
item in DynamoDB. DynamoDB also holds the pre-computed metrics, settings, projects, jobs, assistant
conversations and the state of the other features. This document is for operators and developers
who need to find, inspect or repair stored data: the S3 layout, the tables and their keys, the
Data Explorer, the S3 import bucket and what is retained. How items get there is in
[Processing Pipeline](processing-pipeline.md).

## S3 Raw Data Structure

Raw feedback (the bronze layer, `raw/`) keeps history: nothing under it is ever overwritten or
expired. It is partitioned by source and date (a plugin item's own `created_at`, or the archive time
when it has none; the ingest date for an API-side upload), with ONE folder per item holding every
version of it:

```
s3://voc-raw-data-<account>-<region>/
└── raw/
    └── {source_platform}/
        └── {year}/{month}/{day}/
            ├── {item_stem}/{sha16}.json   ← one object per distinct content (current layout)
            └── {item_stem}.json           ← legacy single object, written before that
```

Example paths:

```
raw/webscraper/2026/01/08/abc123def456/3f9a0c1d2e4b5a67.json
raw/webscraper/2026/01/08/abc123def456/8b1e2f3a4c5d6e7f.json   ← the same review, edited at the source
raw/webscraper/2025/11/02/abc123def456.json                    ← a legacy object, left as it was
```

- `{item_stem}` derives from the item's source id (or a hash of its date, text and URL;
  `shared/archive_keys.py`).
- `{sha16}` is the first 16 hex characters of the SHA-256 of the canonical JSON (sorted keys) of the
  item's CONTENT: `{"raw_content", "raw_item"}` for a plugin, the queued message without `s3_raw_uri`
  for an API-side writer. No timestamp is hashed, so ingesting identical content again maps to the
  same key and writes nothing new; changed content is a new object next to the old one.
- Every write sends `If-None-Match: *` (`lambda/shared/raw_versions.py`, the one helper every raw
  writer uses). S3's 412 means "this content is already archived" (the writer returns that object's
  URI); a 409 (a concurrent write of the same key) is retried once.
- A correction of a stored item (a confirmed CSV dataset update, [csv-import.md](csv-import.md))
  writes the new version into the stored item's own folder (for a legacy `{item_stem}.json`, the folder
  `{item_stem}/` next to it), and the item's `s3_raw_uri` points at the newest version.
- Legacy objects stay where they are; every reader (category reprocess reads `s3_raw_uri`) and the
  erasure handle both layouts.

Every new raw object carries S3 user metadata `connector` and `connector-version`: the plugin id and
its manifest `version` for an ingestor (`webhook_<plugin>` for a webhook), or the API writer
(`manual_import`, `csv_upload`, `json_upload`, `feedback_form`, `feature_requests`, `email_intake`,
`data_explorer`, `processor`) and the platform release. A source whose PII policy is
`redact` or `summary_only` keeps no raw copy ([source-policies.md](source-policies.md)).

### Every ingested source has a raw copy

| Writer | Where | What | Connector |
|---|---|---|---|
| Plugin ingestors and webhooks | `raw/<source>/…/<item>/<sha16>.json`; an ingestor's run in a workspace (multi-workspace, not released yet, [multi-workspace.md](multi-workspace.md)) under `ws/<ws>/raw/<source>/…` | The mapped item and the payload received (`raw_content`): the App Store RSS entry, the Google Play review, the scraped review element's outer HTML or the JSON-LD `Review` object, the import file's row, the GitHub issue/comment. Bounded at 256 KB, cut with a marker (`plugins/_shared/raw_source.py`) | `<plugin>` / `webhook_<plugin>` |
| Feedback forms (`POST /feedback-forms/{id}/submit`) | `raw/feedback_form/…/<feedback id>/<sha16>.json` | `{form_id, submission}`: the body as the widget sent it, before the source policy | `feedback_form` |
| Feedback boards ([feature-requests.md](feature-requests.md#raw-copies)) | `raw/feature_requests/…/<request id \| support id>/<sha16>.json` | A request on create and every content edit; a +1 on create and every edit. Not queued into `voc-feedback` | `feature_requests` |
| Email inbox ([email-intake.md](email-intake.md#raw-copies)) | `raw/email_intake/…/<item id>/<sha16>.eml` | The email as received; filtered mail too, with metadata `drop-reason` | `email_intake` |
| S3 import originals | `raw/s3_import/…/<file stem>/<sha16>.<csv\|json\|jsonl>` (`ws/<ws>/raw/s3_import/…` for a run in a workspace) | The staged file as uploaded, metadata `original-key`; only when the `s3_import` profile keeps whole files (allow, no retention period) | `s3_import` |
| The processor | `raw/<source>/…/<item>/<sha16>.json` (the processing day) | A message's inline `raw_data`, when its producer's archive write failed (`lambda/shared/raw_fallback.py`) | `processor` |

Each copy is written only when the source's profile permits one (strict read: an unreadable profile
writes nothing) and a failed write is logged, never a lost item (`lambda/shared/raw_copy.py`). The
originals of a file (S3 import) or of a mail are deleted by a whole-source erasure of their source; an
email's copy also goes with its item (its `s3_raw_uri`).

The raw envelope written by ingestors and webhooks (`plugins/_shared/raw_archive.py`) is:

```json
{
  "item_id": "abc123def456",
  "source_platform": "webscraper",
  "connector": {"id": "webscraper", "version": "1.0.0"},
  "content_sha16": "3f9a0c1d2e4b5a67",
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

The bucket is versioned and KMS-encrypted. Ingestor roles may only put objects under `raw/` and each
workspace's `ws/<ws>/raw/` (a run in a workspace archives there, [multi-workspace.md](multi-workspace.md)):
they cannot read or delete. Only `voc-retention` deletes raw objects, for an opt-in per-source retention
period or an erasure request; in `ws/<ws>/raw/` and `ws/<ws>/silver/` for an erasure by email or a retention
window, never for a whole-source erasure (Unreleased, [Source policies → Workspace items](source-policies.md#retention-and-erasure)). The bucket policy denies every PutObject under `raw/`, `silver/`, `ws/<ws>/raw/` and
`ws/<ws>/silver/` that does not send `If-None-Match` (the IAM patterns pin `<ws>` to one id, `ws_` and 26 `?`,
as do the ingestor roles' puts: IAM's `*` also matches `/`) (statement `DenyRawWritesWithoutIfNoneMatch`, `lib/stacks/core-buckets.ts`),
so no writer, ours or a custom out-of-band one, can overwrite a raw object; a CopyObject into `raw/`
is refused too. The Data Explorer (admin-only) can create a new object but refuses (409) to
overwrite an existing key under `raw/`. No lifecycle rule expires anything under `raw/` or `ws/`, current or
noncurrent. The other prefixes (below) have no noncurrent-version rule either (since 6.00.00): a workspace
delete removes every version of the object itself, and only `scratch/` expires (current and noncurrent versions
after 2 days). The bucket is kept when the stacks are deleted (`protectData`, the default); under
`-c protectData=false` deleting the stack empties the bucket (every version) and deletes it; back up first
([Deployment → Teardown](deployment.md#teardown-with--c-protectdatafalse-back-up-first)).

### Silver history (`silver/`)

A processed feedback item (`voc-feedback`, the Silver tier) changes in place when a person corrects it, a
source sends a newer copy or a reprocess re-derives it. Once such a change has landed, the item **as it was**
before it is written to the raw bucket (TENETS.md D1, `lambda/shared/silver_provenance.py`). A change its
condition refused (a concurrent edit, a manual correction that won, an item gone) keeps no version, so the
history never records a change that did not happen:

```
silver/{source_platform}/{feedback_id}/{YYYYMMDDTHHMMSSffffffZ}-{sha8}.json
  {item, actor: {sub, kind}, reason, changed_fields, kept_at}
```

- **Who writes it, and why** (`reason`): `PUT /feedback/{id}/category` (`category_edit`),
  `PUT /feedback/{id}/dimensions` (`dimensions_edit`), `PUT /data-explorer/feedback` (`data_explorer_edit`),
  the processor for a GitHub issue refresh (`source_update`) and a confirmed CSV correction (`csv_correction`),
  and the category reprocess worker (`reprocess`). `actor.kind` is `user`, `admin`, `agent`, `mcp`, `plan` (a
  plan step acting for its approver) or `system` (the queue).
- **Write-once and kept forever**, like `raw/`: every put sends `If-None-Match: *` and the bucket policy
  denies one without it (`lib/stacks/core-buckets.ts` `APPEND_ONLY_PREFIXES`); no lifecycle rule expires
  anything under it. Only `voc-retention` deletes there: every version of an erased or expired item goes
  with it ([Source policies → Retention and erasure](source-policies.md#retention-and-erasure)).
- **The same data protection as the item.** A kept version is a copy of the Silver row, which is already
  policy-applied: for a `redact` or `summary_only` source it holds only what the item held (redacted text,
  or the summary and no customer words), never more.
- **Never fails the change.** A failed put is logged (no content) and counted (`SilverVersionFailures`,
  namespace `VoC`); the change goes on.

Every changed item also carries who changed it: `updated_by {sub, kind}`, `updated_at`, `change_reason`.
A client reads `updated_by.kind` only: the API's response sanitiser and the assistant's source cards drop
the `sub` (`shared/category_override.py`).

Every enriched item says how it was made (TENETS.md D2): `pipeline_version` (the app release, env
`APP_VERSION`), `enrichment_mode` (`llm`; `defaults` when the model call failed and the fallback values were
stored; `source_update`; `reprocess_processed` / `reprocess_raw` /
`reprocess_dimensions`), `enriched_at` and `llm_metadata {model_name, requested_model, prompt_version,
latency_ms, error?}`. `model_name` is the model that answered (after a capacity fallback it differs from
`requested_model`). `prompt_version` is pinned to a digest of the enrichment prompts
(`shared/test/test_prompt_version_pin.py`): a prompt change without a bump fails the tests. A person's edit leaves these as they were and stamps `updated_by` / `updated_at` / `change_reason`
instead (which values a person set is `category_source` / `dimension_sources`). Items stored
before 6.03.00 have no `pipeline_version` / `enrichment_mode`, and their `prompt_version` reads `1.0.0`.

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
| `voc-watermarks` | `source` (`<plugin_id>#<key>`; `WS#<ws>#<plugin_id>#<key>` for a run in a workspace, [multi-workspace.md](multi-workspace.md), not released yet) | Per-source ingestion progress |
| `voc-projects` | `pk`, `sk` | Project metadata, personas, artifacts, document comments and review links, global MCP tokens (`MCPGTOKEN`), and managed-version state |
| `voc-jobs` | `pk=PROJECT#<id>`, `sk=JOB#<id>` | Long-running research and generation jobs, and assist jobs |
| `voc-conversations` | `pk=USER#<subject>`, `sk=CONV#<id>` | Per-user AI assistant sessions (`kind=assistant`; `messages_json`/`page_json`/`pending_json` JSON strings, `message_count`, item kept under ~350 KB) and legacy chat records (native `messages` list); current writes do not set TTL |
| `voc-idempotency` | `id` | Processor and aggregator retry claims |
| `voc-memory` | `pk`, `sk` | Company and personal memory ([memory.md](memory.md)) |
| `voc-agents` | `pk`, `sk` | Agents, workflows, runs and assistant plans ([autonomous-agents.md](autonomous-agents.md)) |
| `voc-radar` | `pk`, `sk` | Other brands' reviews, kept out of your own metrics ([radar.md](radar.md)) |
| `voc-participants` | `pk`, `sk` | People to ask for feedback, lists and asks ([participants.md](participants.md)) |
| `voc-feature-requests` | `pk`, `sk` | Feedback boards and their requests ([feature-requests.md](feature-requests.md)) |
| `voc-workspaces` | `pk`, `sk` | Workspaces, members, invites, slugs, the platform console's listing (`WORKSPACES`) and their audit; read and written by the workspaces API (`/me/*`, `/platform/*`): platform admins create workspaces (one transaction, the creator as admin), a platform admin's entry is audited, and a workspace's admins add members, change roles and remove members (a member may leave), each change audited first and written to the `MEMBER#` and `USER#` rows in one transaction (its one delete: a removal's two rows); no invite rows are written (membership is immediate). Since 6.11.00 two more roles write it: the users API removes a deleted user's memberships before the account (each `AUDIT#WS#` row first, then the `MEMBER#` and `USER#` delete), and `voc-retention`'s erasure by email removes `email` and `name` from the person's `MEMBER#` rows after a tombstone ([multi-workspace.md](multi-workspace.md#invites)). The scheduled plugin ingestors Query its `PLUGIN#<plugin>` partitions only (the workspaces that enabled the plugin, for the tick's fan-out; nothing writes them yet) |

### Feedback table indexes

| Index | Partition key | Sort key | Use case |
|-------|---------------|----------|----------|
| `gsi1-by-date` | `gsi1pk = DATE#<processing date>` | `gsi1sk = <processing timestamp>#<id>` | Date-window queries |
| `gsi2-by-category` | `gsi2pk = CATEGORY#<category>` | `gsi2sk = <sentiment score>#<timestamp>` | Category queries |
| `gsi3-by-urgency` | `gsi3pk = URGENCY#<urgency>` | `gsi3sk = <timestamp>` | Urgent-item queries (slim projection) |
| `gsi4-by-feedback-id` | `gsi4pk = FEEDBACK#<id>` | — | Direct lookup independent of source partition |
| `gsi5-by-channel` | `gsi5pk = CHANNEL#<source_channel>` | `gsi1sk` (processing time) | Channel-filtered lists and metrics; slim projection (`CHANNEL_INDEX_FIELDS` in `lambda/shared/channel_index.py`, `source_channel` included), so a small channel in a big import is read without reading the whole day |

The date index is keyed by when the processor stored the item, not by the review's own date.

gsi4 and gsi5 are keyed on `gsi4pk` / `gsi5pk` (Unreleased; a workspace's item carries `WS#<ws>#…` in every key):
an existing deployment does not take that release in place ([Multi-workspace → Upgrading](multi-workspace.md#upgrading)).

Feedback items do not expire: the table has no TTL and the processor stamps none. Only
`voc-retention` deletes feedback, when a source profile sets `retention_days` or an administrator
requests an erasure ([source-policies.md](source-policies.md)). Deployments that predate this carry a legacy
`ttl` on old items until `scripts/retention/remove_ttl.py --apply` removes it (see [Deployment → Data
Retention](deployment.md#data-retention-nothing-is-ever-deleted)). Category corrections
(`category_source='manual'`, `category_override`) and reprocessing (`category_source='reprocess'`) update
items in place; see [Categories](categories.md).

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
| `AUDIT#platform-admins` / `<iso>#<random>` | Every grant and revoke of the `platform-admins` group (kept, no TTL; written only by the users API, [multi-workspace.md](multi-workspace.md#control-plane)) |
| `LOGS#validation#<source>`, `LOGS#processing#<source>` | Validation and processing logs (7-day TTL); a workspace's message (Unreleased, [multi-workspace.md](multi-workspace.md)) logs under `WS#<ws>#LOGS#validation#<source>` and `WS#<ws>#LOGS#processing#<source>`, which `GET /logs/*` does not read yet |
| `FEEDBACK_FORM` | Feedback-form configuration and statistics |
| `SOURCE_RUN#<source>` / `<execution id>` | Manual and reprocess runs of a plugin ingestor (`WS#<ws>#SOURCE_RUN#<source>` for a run in a workspace) |
| `SCRAPER_RUN#<scraper id>` | Scraper run state (`WS#<ws>#SCRAPER_RUN#<scraper id>` in a workspace) |
| `CIRCUIT#<plugin>` / `TRIPPED`, `FAILURES#<plugin>` | Plugin circuit breaker ([plugin-architecture.md](plugin-architecture.md#circuit-breaker)); a run in a workspace keeps `WS#<ws>#CIRCUIT#<plugin>` and `WS#<ws>#FAILURES#<plugin>` |
| `IMPORT_RUN`, `IMPORT_RUN#<run id>` | Import history (kept, no TTL; rows from earlier releases keep their 90-day TTL, [import-history.md](import-history.md)); an S3 import run in a workspace writes `WS#<ws>#IMPORT_RUN` and `WS#<ws>#IMPORT_RUN#<run id>` |
| `PRIORITIZATION` / `ROW#<id>` | Prioritization rows ([prioritization.md](prioritization.md)) |

Metric rows are kept indefinitely (no `ttl`). The table keeps TTL enabled for its operational rows (logs,
circuit-breaker failures, import history, voting sessions). Settings and other durable configuration rows
omit TTL. See [Processing Pipeline](processing-pipeline.md#rebuilding-aggregates-for-a-window) before
repairing counters.

### Projects table

A project uses `pk=PROJECT#<project_id>`. Its sort keys include `META`, `PERSONA#<id>`, managed artifact
prefixes such as `PRD#`, `PRFAQ#`, and `PROTOTYPE#`, and uploaded `DOC#` rows. The index `gsi1-by-type`
lists items of one type, such as every project.

PRDs, PR/FAQs, and prototypes have internal version state in a separate partition:

```
pk = DOCUMENT_VERSIONS#PROJECT#<project_id>
sk = <DOCUMENT_TYPE>#<title-digest>                 # series counter
sk = ALLOCATION#<DOCUMENT_TYPE>#<allocation-digest> # durable allocation history
```

These rows preserve monotonic version numbers and retry identity. They deliberately survive document
deletion; deleting or rewriting them can make delayed retries conflict or reuse version numbers. Manage
artifacts through the application/API, not by deleting internal rows directly.

### Jobs, conversations, and idempotency

- Job rows use TTL (`ttl`). Completed and failed jobs remain available briefly for progress and diagnostics;
  assist jobs expire after 1 day. The index `gsi1-by-status` lists jobs by status.
- Conversations are partitioned by authenticated user. Although the table has a `ttl` attribute configured,
  current conversation writes omit it, so rows persist until explicitly deleted or the stack is destroyed.
- Two writers share an assistant conversation item: the SPA (`POST /chat/conversations/{id}`) and the stream
  Lambda, which saves the conversation while a run streams (user turn + in-progress answer, `run_id`,
  `run_status` running/finished/failed/interrupted/stopped, `revision`). A reload mid-answer therefore finds
  the partial answer and the SPA polls until it finishes. The server owns a run's answer: an SPA save is
  refused (409) while the run is live (last write < 960 s ago) or when its `baseRevision` is older than the
  stored `revision`. The stream Lambda's role holds only `GetItem`/`PutItem` on the table; it always writes
  the verified caller's own partition. Stop in the assistant writes a separate marker item `pk USER#{sub}`,
  `sk RUNCANCEL#{conversation id}` (`run_id`, `ttl` one day) through `POST /chat/conversations/{id}/cancel`;
  the running stream Lambda polls it (GetItem every 1.5 s), stops generating and saves the partial answer as
  `stopped`. The conversation list reads `CONV#` keys only, so the marker never lists.
- Idempotency rows use the `expiration` TTL attribute. Processor and aggregator keys share the table but use
  distinct namespaces.

## Data Explorer

The Data Explorer browses the raw-data bucket and edits selected S3 or feedback records. It is an
operational/debugging surface, not a replacement for project and version APIs. It is **admin-only** on every
route (raw S3 cannot be filtered by category access), and it cannot delete: there is no DELETE route at API
Gateway and its role holds no delete permission.

Folders read by name, the stored key staying the row's tooltip: the top folders and source folders by their
label, and an avatar folder (`avatars/<persona id>`) by the persona and when it was made, "Persona 2 · Oct
24, 2026, 12:34 PM" (`persona_<stamp>_<hex>_<index>`), or "Persona · Oct 24, 2026, 12:34 PM" for an id
without a batch index (an imported persona, or an id from before the random suffix).

### API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/data-explorer/buckets` | List available logical buckets |
| GET | `/data-explorer/s3` | List S3 objects |
| GET | `/data-explorer/s3/preview` | Preview file content |
| PUT | `/data-explorer/s3` | Create a file, optionally reprocess it (409 when overwriting an existing `raw/` key) |
| PUT | `/data-explorer/feedback` | Update a feedback record in place: only the fields that differ from the stored record; each is validated (enums, bounds) and put through the source's PII policy (the stricter of the item's and the profile's; `summary_only` refuses setting `original_text` / `normalized_text`, 400; `normalized_text` may be removed, `original_text` never (every review needs one); unreadable profiles 503). The write is conditional on the record being unchanged since it was read (its `updated_at`): 409 when a change landed meanwhile, 404 when it is gone. Once the edit landed, the record as it was is kept under `silver/` and the edit is stamped (`updated_by`, `change_reason: data_explorer_edit`) |

## S3 Import Bucket

The S3 import bucket (`voc-import-<account>-<region>`, `VocIngestionStack` output
`S3ImportBucketName`) is a staging bucket, separate from the raw data lake. A `.csv`, `.json` or
`.jsonl` file uploaded under `<source>/` triggers the `s3_import` ingestor, which queues each row for
processing under the source `S3 - <source>`. The bucket is versioned (an overwrite or delete is
recoverable for 7 days), staged files expire 90 days after upload, and `processed/` is reserved
(moved to Glacier after 30 days). The import bucket is an inbox, not the archive: before a file is read,
its original goes to the raw lake (`raw/s3_import/…`, above) when the `s3_import` profile keeps whole
files. Reprocess works on staged files only: once a file has expired, `POST /s3-import/reprocess`
answers 404 naming the raw copy, and the file is uploaded again from it. Administrators use the file
explorer on the **S3 Bulk Import**
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
| POST | `/s3-import/reprocess` | Admin | Re-run one file through the `s3_import` ingestor, body `{key}` → **202** `{success, run}`. The key is `<source>/<file>` (validated as for delete) or `processed/<source>/<file>`; 400 for any other key, an empty file or one over the ingestor's 50 MB limit, 404 when the key holds nothing (the message says the staged copy expires and where the raw copy is) |
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
- **Raw archive.** A row is archived in a folder derived from its id and its date, under a key
  derived from its content, so a re-run of an unchanged file writes nothing new and a changed row is a
  new version next to the old one; a row with no date is archived under the day of the re-run.

## Data Flow

```
External source → Ingestor/API → S3 raw archive → SQS → Processor → Feedback table
                                                           │
                                                           └→ DynamoDB Stream → Aggregates
Projects UI/API → Jobs → Bedrock → Projects table + S3 artifact assets
```

## Retention

Customer data is not deleted while the platform runs, apart from opt-in per-source retention and erasure
requests ([Source policies](source-policies.md)). Deleting the stacks keeps it by default (`protectData`);
under `-c protectData=false` it deletes all of it; back up first ([Deployment →
Teardown](deployment.md#teardown-with--c-protectdatafalse-back-up-first)). Details and the migration for
existing deployments: [Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted).

- **S3 raw data:** kept under `raw/` while the platform runs, with every version, unless a source's
  retention or an erasure removes it (nothing there is overwritten or expires); the same holds for the
  Silver history under `silver/`; previous versions of
  overwritten objects under the other prefixes are kept 90 days; the bucket is deleted with the stack only
  under `-c protectData=false`. Project assets in the same bucket are managed by the project APIs.
- **Feedback:** no expiry unless a source profile sets `retention_days`; the table is deleted with the stack
  only under `-c protectData=false`.
- **Daily aggregate metrics:** no expiry; the table is deleted with the stack only under `-c protectData=false`.
- **Projects:** no expiry; the table is deleted with the stack only under `-c protectData=false`.
- **Processing logs:** seven-day TTL.
- **Jobs and idempotency:** item-specific TTL appropriate to progress visibility or retry guarantees.
- **Conversations:** no automatic expiry on current writes; delete through the application/API when no
  longer needed.

## Querying Feedback

Use indexes rather than scans. For example, the items processed on one day come from `gsi1-by-date`:

```python
response = table.query(
    IndexName='gsi1-by-date',
    KeyConditionExpression='gsi1pk = :pk',
    ExpressionAttributeValues={':pk': 'DATE#2026-01-08'},
)
```

Use the application APIs where possible: they enforce authorization, pagination ceilings, partial-window
reporting, and project tombstones that a direct table read bypasses.
