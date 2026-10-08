# Data Lake Structure

This document describes the VoC data lake architecture, including S3 storage, DynamoDB tables, and the Data Explorer.

## Overview

The platform stores a raw source archive and generated binary assets in S3. DynamoDB holds processed feedback, aggregates, project artifacts, jobs, conversations, and idempotency state.

## S3 Raw Data Structure

Raw feedback is partitioned by source and ingestion date:

```
s3://voc-raw-data-bucket/
└── raw/
    └── {source_platform}/
        └── {year}/{month}/{day}/{item_id}.json
```

Example paths:

```
raw/webscraper/2026/01/08/abc123def456.json
raw/feedback_form/2026/01/08/uuid-here.json
```

The raw envelope written by ingestors is:

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

The bucket is not versioned, but raw data is immutable by policy: there is no delete route, the Data Explorer (admin-only) can create a new object but refuses (409) to overwrite an existing key under `raw/`, and the bucket is RETAINed on stack deletion. Other prefixes store project uploads, extracted product context, persona avatars, and generated prototype assets.

## DynamoDB Tables

All tables use on-demand capacity and customer-managed KMS encryption. Table names include the deployment namespace, account, and region.

| Table | Primary key | Purpose |
|-------|-------------|---------|
| Feedback | `pk=SOURCE#<platform>`, `sk=FEEDBACK#<id>` | Processed feedback and enrichment |
| Aggregates | `pk`, `sk` | Daily metrics, settings, logs, form configs, scraper runs, ballots, and voting sessions |
| Watermarks | `source` | Per-source ingestion progress |
| Projects | `pk`, `sk` | Project metadata, personas, artifacts, prioritization rows, MCP credentials, and managed-version state |
| Jobs | `pk=PROJECT#<id>`, `sk=JOB#<id>` | Long-running research and generation jobs |
| Conversations | `pk=USER#<subject>`, `sk=CONV#<id>` | Per-user AI assistant sessions (`kind=assistant`; `messages_json`/`page_json`/`pending_json` JSON strings, `message_count`, item kept under ~350 KB) and legacy chat records (native `messages` list); current writes do not set TTL |
| Idempotency | `id` | Processor and aggregator retry claims |

### Feedback table indexes

| Index | Partition key | Sort key | Use case |
|-------|---------------|----------|----------|
| `gsi1-by-date` | `DATE#<date>` | `<timestamp>#<id>` | Date-window queries |
| `gsi2-by-category` | `CATEGORY#<category>` | `<score>#<timestamp>` | Category queries |
| `gsi3-by-urgency` | `URGENCY#<urgency>` | `<timestamp>` | Urgent-item queries |
| `gsi4-by-feedback-id` | `feedback_id` | — | Direct lookup independent of source partition |

Feedback items never expire: the table has no TTL and the processor stamps none. Deployments that predate this carry a legacy `ttl` on old items until `scripts/retention/remove_ttl.py --apply` removes it (see [Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted)). Category corrections (`category_source='manual'`, `category_override`) and reprocessing (`category_source='reprocess'`) update items in place — see [Categories](categories.md).

### Aggregates table

Common key families include:

| Key pattern | Purpose |
|-------------|---------|
| `METRIC#*` | Pre-computed daily counters and averages |
| `SETTINGS#*` | Brand, category (with product + owners), and model configuration |
| `CATEGORY_ACCESS` / `USER#<sub>` | Which categories a user may see (no row = all) |
| `JOB#category_reprocess` / `rp_<hex>` | Category reprocess jobs |
| `METRIC#meta` / `earliest_date` | Earliest-data watermark used by all-time (`days=0`) windows |
| `LOGS#*` | Validation and processing logs |
| `FEEDBACK_FORM*` | Feedback-form configuration and statistics |
| `SCRAPER_RUN#*` | Scraper run state |

Metric rows are kept indefinitely (no `ttl`). The table keeps TTL enabled for its operational rows (processing logs, voting sessions). Settings and other durable configuration rows omit TTL. See [Processing Pipeline](processing-pipeline.md#rebuilding-aggregates-for-a-window) before repairing counters.

### Projects table

A project uses `pk=PROJECT#<project_id>`. Its sort keys include `META`, `PERSONA#<id>`, managed artifact prefixes such as `PRD#`, `PRFAQ#`, and `PROTOTYPE#`, uploaded `DOC#` rows, and prioritization state.

PRDs, PR/FAQs, and prototypes have internal version state in a separate partition:

```
pk = DOCUMENT_VERSIONS#PROJECT#<project_id>
sk = <DOCUMENT_TYPE>#<title-digest>                 # series counter
sk = ALLOCATION#<DOCUMENT_TYPE>#<allocation-digest> # durable allocation history
```

These rows preserve monotonic version numbers and retry identity. They deliberately survive document deletion; deleting or rewriting them can make delayed retries conflict or reuse version numbers. Manage artifacts through the application/API, not by deleting internal rows directly.

### Jobs, conversations, and idempotency

- Job rows use TTL. Completed and failed jobs remain available briefly for progress and diagnostics.
- Conversations are partitioned by authenticated user. Although the table has a `ttl` attribute configured, current conversation writes omit it, so rows persist until explicitly deleted or the stack is destroyed.
- Two writers share an assistant conversation item: the SPA (`POST /chat/conversations/{id}`) and the stream Lambda, which saves the conversation while a run streams (user turn + in-progress answer, `run_id`, `run_status` running/finished/failed/interrupted, `revision`). A reload mid-answer therefore finds the partial answer and the SPA polls until it finishes. The server owns a run's answer: an SPA save is refused (409) while the run is live (last write < 360 s ago) or when its `baseRevision` is older than the stored `revision`. The stream Lambda's role holds only `GetItem`/`PutItem` on the table; it always writes the verified caller's own partition.
- Idempotency rows use the `expiration` TTL attribute. Processor and aggregator keys share the table but use distinct namespaces.

## Data Explorer

The Data Explorer browses the raw-data bucket and edits selected S3 or feedback records. It is an operational/debugging surface, not a replacement for project and version APIs. It is **admin-only** on every route (raw S3 cannot be filtered by category access), and it cannot delete: there is no DELETE route at API Gateway and its role holds no delete permission.

### API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/data-explorer/buckets` | List available logical buckets |
| GET | `/data-explorer/s3` | List S3 objects |
| GET | `/data-explorer/s3/preview` | Preview file content |
| PUT | `/data-explorer/s3` | Create a file, optionally reprocess it (409 when overwriting an existing `raw/` key) |
| PUT | `/data-explorer/feedback` | Update a feedback record in place |
| GET | `/data-explorer/stats` | Get data-lake statistics |

## Data Flow

```
External source → Ingestor/API → S3 raw archive → SQS → Processor → Feedback table
                                                           │
                                                           └→ DynamoDB Stream → Aggregates
Projects UI/API → Jobs → Bedrock → Projects table + S3 artifact assets
```

## Retention

Customer data is never deleted — the platform reads and interprets it. Details and the migration for existing deployments: [Deployment → Data Retention](deployment.md#data-retention-nothing-is-ever-deleted).

- **S3 raw data:** kept forever and immutable under `raw/`; the bucket is RETAINed on stack deletion. Project assets in the same bucket are managed by the project APIs.
- **Feedback:** no expiry; the table is RETAINed on stack deletion.
- **Daily aggregate metrics:** no expiry; the table is RETAINed on stack deletion.
- **Projects:** no expiry; the table is RETAINed on stack deletion.
- **Processing logs:** seven-day TTL.
- **Jobs and idempotency:** item-specific TTL appropriate to progress visibility or retry guarantees.
- **Conversations:** no automatic expiry on current writes; delete through the application/API when no longer needed.

## Querying Feedback

Use indexes rather than scans. For example, a date partition query uses `gsi1-by-date`:

```python
response = table.query(
    IndexName='gsi1-by-date',
    KeyConditionExpression='gsi1pk = :pk',
    ExpressionAttributeValues={':pk': 'DATE#2026-01-08'},
)
```

Use the application APIs where possible: they enforce authorization, pagination ceilings, partial-window reporting, and project tombstones that a direct table read bypasses.
