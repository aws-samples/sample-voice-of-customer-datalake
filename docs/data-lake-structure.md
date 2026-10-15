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

The bucket is not versioned. Authorized Data Explorer users can overwrite or delete raw keys, so “archive” describes the normal ingestion path, not an immutability guarantee. Other prefixes store project uploads, extracted product context, persona avatars, and generated prototype assets.

## DynamoDB Tables

All tables use on-demand capacity and customer-managed KMS encryption. Table names include the deployment namespace, account, and region.

| Table | Primary key | Purpose |
|-------|-------------|---------|
| Feedback | `pk=SOURCE#<platform>`, `sk=FEEDBACK#<id>` | Processed feedback and enrichment |
| Aggregates | `pk`, `sk` | Daily metrics, settings, logs, form configs, scraper runs, ballots, and voting sessions |
| Watermarks | `source` | Per-source ingestion progress |
| Projects | `pk`, `sk` | Project metadata, personas, artifacts, prioritization rows, MCP credentials, and managed-version state |
| Jobs | `pk=PROJECT#<id>`, `sk=JOB#<id>` | Long-running research and generation jobs |
| Conversations | `pk=USER#<subject>`, `sk=CONV#<id>` | Authenticated chat history; current writes do not set TTL |
| Idempotency | `id` | Processor and aggregator retry claims |

### Feedback table indexes

| Index | Partition key | Sort key | Use case |
|-------|---------------|----------|----------|
| `gsi1-by-date` | `DATE#<date>` | `<timestamp>#<id>` | Date-window queries |
| `gsi2-by-category` | `CATEGORY#<category>` | `<score>#<timestamp>` | Category queries |
| `gsi3-by-urgency` | `URGENCY#<urgency>` | `<timestamp>` | Urgent-item queries |
| `gsi4-by-feedback-id` | `feedback_id` | — | Direct lookup independent of source partition |

Feedback items receive a one-year `ttl` when processed. DynamoDB expiry is asynchronous; consumers must not assume an item disappears exactly at the deadline.

### Aggregates table

Common key families include:

| Key pattern | Purpose |
|-------------|---------|
| `METRIC#*` | Pre-computed daily counters and averages |
| `SETTINGS#*` | Brand, category, and model configuration |
| `LOGS#*` | Validation and processing logs |
| `FEEDBACK_FORM*` | Feedback-form configuration and statistics |
| `SCRAPER_RUN#*` | Scraper run state |

Metric rows are retained for 90 days. Settings and other durable configuration rows omit TTL. See [Processing Pipeline](processing-pipeline.md#rebuilding-aggregates-for-a-window) before repairing counters.

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
- Idempotency rows use the `expiration` TTL attribute. Processor and aggregator keys share the table but use distinct namespaces.

## Data Explorer

The Data Explorer browses the raw-data bucket and edits selected S3 or feedback records. It is an operational/debugging surface, not a replacement for project and version APIs.

### API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/data-explorer/buckets` | List available logical buckets |
| GET | `/data-explorer/s3` | List S3 objects |
| GET | `/data-explorer/s3/preview` | Preview file content |
| PUT | `/data-explorer/s3` | Create/update a file, optionally reprocess it |
| DELETE | `/data-explorer/s3` | Delete a file |
| PUT | `/data-explorer/feedback` | Update a feedback record |
| DELETE | `/data-explorer/feedback` | Delete a feedback record |
| GET | `/data-explorer/stats` | Get data-lake statistics |

## Data Flow

```
External source → Ingestor/API → S3 raw archive → SQS → Processor → Feedback table
                                                           │
                                                           └→ DynamoDB Stream → Aggregates
Projects UI/API → Jobs → Bedrock → Projects table + S3 artifact assets
```

## Retention

- **S3 raw data and project assets:** normally retained, but authorized APIs can overwrite/delete objects and configured lifecycle/application policies may remove them.
- **Feedback:** one-year TTL from processing.
- **Daily aggregate metrics:** 90-day TTL.
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
