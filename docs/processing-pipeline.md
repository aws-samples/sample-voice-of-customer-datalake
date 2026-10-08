# Processing Pipeline

This document explains how feedback flows through the VoC processing pipeline, from ingestion to storage.

## Overview

The processing pipeline transforms raw feedback into enriched, queryable data:

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Plugin  │───▶│   SQS    │───▶│Processor │───▶│ DynamoDB │
│ Ingestor │    │  Queue   │    │  Lambda  │    │  Table   │
└──────────┘    └──────────┘    └──────────┘    └──────────┘
     │                               │
     ▼                               ▼
┌──────────┐                   ┌──────────┐
│ S3 Raw   │                   │ Bedrock  │
│ Storage  │                   │   LLM    │
└──────────┘                   └──────────┘
```

## Step 1: Ingestion

Plugins fetch data from external sources and send to the processing queue.

### What Plugins Do

1. **Fetch new items** from the data source API
2. **Store raw data** to S3 (immutable archive)
3. **Normalize** to standard message format
4. **Send to SQS** for processing

### Message Format

```python
{
    "id": "source_unique_id",
    "source_platform": "webscraper",
    "source_channel": "review",
    "text": "The feedback content",
    "rating": 4.5,
    "created_at": "2026-01-08T10:30:00Z",
    "ingested_at": "2026-01-08T10:35:00Z",
    "brand_name": "MyBrand",
    "url": "https://source.com/review/123",
    "s3_raw_uri": "s3://bucket/raw/webscraper/2026/01/08/abc123.json"
}
```

## Step 2: Message Validation

Before processing, every message is validated against `IngestMessage` in
`lambda/shared/ingest_schemas.py` — the one source of truth, shipped in the
processor bundle (`processor/*` + `shared/`). Plugins and tests import it from
there too. The import is unconditional: if the schema cannot be imported the
processor fails its cold start rather than running unvalidated (issue #249 — it
used to live under `plugins/`, which the bundle never contained, so validation was
silently off in every deployment). For sanitization details see
[Plugin Architecture - SQS Message Validation](plugin-architecture.md#sqs-message-validation-layer).

### Validation Rules

Unknown fields are rejected (`extra='forbid'`), so every field a producer sends
is declared. `plugins/_shared/test/test_schemas.py::TestProducerShapes` pins one
message per producer (webscraper, app reviews iOS/Android, s3_import,
synthetic_reviews, GitHub webhook, manual-import confirm/CSV/JSON, feedback-form
submit) — add a field to a producer and its case there.

| Field | Rule |
|-------|------|
| `id` | Required, non-blank, max 256 chars |
| `source_platform` | Required, non-blank display name, max 256 (e.g. `MyApp_iOS`, `S3 - surveys`, a scraper's name) |
| `text` | Required, max 50KB |
| `created_at` | Required; not more than 1 day in the future. A blank or unparseable value (s3_import's `""`, a scraped "3 days ago") falls back to `ingested_at`, else now |
| `rating` | Optional, 1-10 (the widget's numeric scale is 1..10) |
| `url`, `source_url` | Optional, http/https, max 4096 |
| `source_channel` | Optional, max 128 (`form_<form id>`) |
| `ingestion_method`, `source_origin`, `manual_import_job_id` | Optional manual-import provenance (64 / 256 / 256) |
| `preset_category`, `preset_subcategory` | Optional feedback-form routing, max 128 |
| `metadata` | Flat primitives, plus `custom_fields`: ≤20 scalar answers, keys ≤64, values ≤1000 |

### Validation Failures

Failed messages are:
- Logged to DynamoDB (`LOGS#validation#{source}`) and counted (`ValidationFailures` metric)
- Failed as a batch item (`MessageRejectedError`), so SQS keeps them and, after
  `maxReceiveCount` (3), moves them to the processing DLQ for inspection and
  re-drive — never deleted
- Visible in Settings → Logs

The aggregator's DynamoDB stream source likewise retries a failing batch 3 times
and then records the discarded shard range on the `voc-aggregator-stream-failures`
queue (an on-failure destination, #253) instead of dropping it silently.

## Step 3: Deduplication

The processor prevents duplicate entries using deterministic IDs.

### ID Generation

```python
# If source provides an ID
feedback_id = hash(f"{source_platform}:{source_id}")

# Fallback for scraped content
text_hash = sha256(text[:500])
feedback_id = hash(f"{source_platform}:{created_at}:{text_hash}:{url}")
```

### Duplicate Check

Before LLM processing, the system checks if the feedback already exists in DynamoDB.

## Step 4: Language Processing

### Language Detection

Uses Amazon Comprehend to detect the original language.

### Translation

If the detected language differs from the primary language (default: English), the text is translated using Amazon Translate.

### Sentiment Analysis

Amazon Comprehend provides baseline sentiment:
- Label: positive, negative, neutral, mixed
- Score: -1.0 to 1.0

## Step 5: LLM Enrichment

The processor uses Amazon Bedrock (Claude) to extract structured insights.

### LLM Prompt

The system prompt instructs the LLM to analyze feedback and return JSON:

```
You are an expert customer experience analyst. Analyze feedback and return ONLY valid JSON:
- Be objective and accurate
- Never invent PII
- Use exact enum values specified
- Keep summaries under 500 chars
```

### Extracted Fields

| Field | Description |
|-------|-------------|
| `category` | Feedback category (from configured list) |
| `subcategory` | More specific classification |
| `journey_stage` | Customer journey phase |
| `sentiment_label` | positive/neutral/negative/mixed |
| `sentiment_score` | -1.0 to 1.0 |
| `urgency` | low/medium/high |
| `impact_area` | product/operations/cx/tech/pricing/brand/legal/other |
| `problem_summary` | Brief description of the issue |
| `problem_root_cause_hypothesis` | Potential root cause |
| `direct_customer_quote` | Key quote from feedback |
| `persona` | Inferred customer persona |

### Categories Configuration

Categories are loaded from DynamoDB (`SETTINGS#categories`). Configure via Settings → Categories, where each category is also mapped to a product and its product owners. The prompt helpers live in `lambda/shared/categorization.py`, shared with the category reprocess worker. See [Categories](categories.md).

Default categories if not configured:
```
delivery | customer_support | product_quality | pricing | 
website | app | billing | returns | communication | other
```

## Step 6: Storage

Processed feedback is stored in DynamoDB with multiple access patterns.

### Primary Key

```
pk: SOURCE#{source_platform}
sk: FEEDBACK#{feedback_id}
```

### GSI Keys

```
gsi1pk: DATE#{date}        gsi1sk: {timestamp}#{id}
gsi2pk: CATEGORY#{cat}     gsi2sk: {score}#{timestamp}
gsi3pk: URGENCY#{urgency}  gsi3sk: {timestamp}
```

## Customizing the Prompt

### Location

The LLM prompt is defined in `lambda/processor/handler.py`:

```python
SYSTEM_PROMPT = """You are an expert customer experience analyst..."""

USER_PROMPT_TEMPLATE = """Analyze this feedback and return JSON:

Source: {source_platform} | Channel: {source_channel} | Rating: {rating}
Text: {original_text}

{categories_instruction}

Return ONLY this JSON structure:
{{...}}"""
```

### Modifying Categories

1. Go to **Settings** → **Categories**
2. Add/edit/remove categories and subcategories
3. Changes take effect for new feedback immediately (cached for 5 minutes)
4. To re-categorise feedback that is already stored, use **Reprocess existing feedback** in the same editor ([Categories → Reprocess](categories.md#reprocessing-existing-feedback))

### Changing the Model

Model selection is configuration-driven; do not set `BEDROCK_MODEL_ID` directly on a Lambda. In **Settings → AI Models**, an administrator can choose a curated Claude model per surface (chat, documents, prototypes, enrichment, and utilities). The shared `model_config.py` resolver applies those choices to every caller.

For accounts that can invoke only one model, pin the deployment-wide default at deploy time:

```bash
cdk deploy --all -c defaultModelId=global.anthropic.claude-sonnet-4-6
```

The id must be in the curated allowlist, the pin is write-once, and later per-surface admin choices still take precedence. See [Pinning All AI Surfaces to One Model](deployment.md#pinning-all-ai-surfaces-to-one-model) for account-access checks and upgrade behavior.

## Error Handling

### Bedrock Throttling

If Bedrock is throttled:
1. Exponential backoff retry (up to 5 attempts)
2. If still throttled, message stays in SQS
3. SQS visibility timeout triggers retry later

### Processing Errors

Errors are logged to DynamoDB (`LOGS#processing#{source}`) and visible in Settings → Logs.

## Idempotency

Both consumers deduplicate, against the same DynamoDB table, for the same reason:
their event sources deliver at-least-once.

### Processor (SQS)

AWS Lambda Powertools idempotency:

- Idempotency key: `{source_platform}:{source_id}`
- Records cached for 1 hour
- Prevents duplicate writes on SQS retries

### Aggregator (DynamoDB Streams)

The aggregator applies one counter update per dimension (`counter_dimensions` in
`voc-datalake/lambda/aggregator/handler.py` — seven for a fully-populated item today,
and designed to be extended) plus a running average per feedback
record. Its event source is configured with `retryAttempts: 3` and
`reportBatchItemFailures: true`, so a batch that partially fails re-presents records
whose writes already landed — and because these counters are only ever incremented,
that divergence is permanent.

An **arrival** (`INSERT`) therefore claims the stream record's `eventID` in the
idempotency table inside the *same* `TransactWriteItems` as its counters:

- Idempotency key: `aggregator#stream#{eventID}` (namespaced, since the table is
  shared with the processor)
- Claims expire after 48 hours, comfortably outliving the 24 hours a stream record
  can survive
- A redelivered record cancels the transaction and moves nothing
- A record that fails partway leaves *nothing* applied, so the daily total can never
  disagree with the sum of the per-category counts

A **reversal** (`REMOVE`, and the decrement half of a `MODIFY`) is *not* transacted,
and this is deliberate. Every decrement is a conditional write
(`attribute_exists(pk) AND #field >= :floor`) whose refusal the code above it reads to
decide what to do next, while `TransactWriteItems` reports no per-item outcome — one
refused item cancels the whole transaction. So a redelivered reversal still decrements
a second time, bounded by that floor: no counter goes negative and no expired row is
resurrected. `AggregateRecordReplayed` in CloudWatch counts the arrivals the claim
refused.

#### What a transaction costs, and where contention shows up

Two prices, both accepted deliberately:

- **An arrival's write capacity is a little over double, and it is billed on two
  tables, not one.** Two separate effects, and conflating them understates it:
  DynamoDB charges a transactional write at **2× the WCU** of the same write sent on
  its own, *and* the transaction adds a write that did not exist before. That second
  write is the dedupe claim, and it lands in the **idempotency table**, not the
  aggregates table the counters live in — so the two effects are also two separate
  bills. On the **aggregates table**: one write per dimension plus the average, at 2×
  WCU, is `(counter_dimensions + 1) × 2`. On the **idempotency table**: one write, at
  2× WCU, is `1 × 2`. Together, `(counter_dimensions + 2) × 2` WCU is the arrival's
  total cost rather than either table's bill alone. Expressed against
  `counter_dimensions` rather than as a fixed multiple, because the dimension count is
  meant to grow. Both tables are `PAY_PER_REQUEST`, so this is a bill rather than a
  ceiling to breach.
- **Same-date records now contend.** Every record of a date moves
  `METRIC#daily_total`, and `TransactWriteItems` conflicts on a contended item where
  two plain `update_item`s would simply have serialised. A bulk import (the
  `s3_import` plugin, or `TRIM_HORIZON` after a redeploy) is the shape that produces
  this at volume — and the same shape produces throttling, which for a transaction
  arrives as a cancellation carrying a `ThrottlingError` *reason* rather than as a
  throttling error, so botocore's own retry policies never match it.

Contention converges rather than losing records, and it is bounded in three places:
the transaction is re-attempted in process with a jittered backoff whenever the
cancellation is **transient** — contention or throttling, the reasons named in
`_RETRYABLE_CANCELLATION_REASONS`, and never a validation failure that would fail
identically on the next attempt (`TRANSACT_WRITE_ATTEMPTS = 3`, the same value as
`ballots_handler`'s `BALLOT_WRITE_ATTEMPTS` for the same DynamoDB reason, though
nothing couples the two); past that bound the stream redelivers the record; and the
claim makes every one of those retries a no-op if an earlier attempt landed.

`AggregateTransactionConflicted` in CloudWatch is the number to watch, since a retry
that succeeds is otherwise invisible. If it climbs during an import, the levers are the
event source's `batchSize` and `parallelizationFactor` in
`voc-datalake/lib/stacks/processing-stack-consolidated.ts` — not a wider transaction,
which would put the conditional reversal writes inside it and disable the aged-out-day
protections described above.

## Rebuilding aggregates for a window

Aggregate rows are pre-computed counters, so any drift already stored stays stored —
the idempotency above stops new drift arriving but repairs nothing written earlier.
There is no scheduled reconciliation job; the procedure below is the supported repair,
and it is short enough that a job would be out of proportion to how rarely it is
needed.

**Write absolute values. Never replay deltas.** The counter updates use
`SET #field = if_not_exists(#field, :zero) + :inc`, so a delta replayed against a row
that is missing (a legacy row that aged out under the old 90-day TTL, or one never
written) *recreates* that row — holding a negative count for a date whose real totals
are not there, which
`/metrics/summary` would then serve as that day's figures. An absolute `PUT` cannot do
that: it either overwrites a row that is there or writes the correct value for a row
that is not.

For each date `D` in the window:

1. **Recompute from source.** Query the feedback table for the items of `D` and count
   them per dimension — total, `source_platform`, `category`, `sentiment_label`,
   `persona_type` bucket, `urgency == 'high'`, and the category+sentiment pair. The
   dimensions and their pk spellings are defined in one place,
   `counter_dimensions` in `voc-datalake/lambda/aggregator/handler.py`; read them from
   there rather than re-deriving, since a rebuild that buckets differently from the
   writer produces rows the read path cannot find.
2. **Write each row with `put_item`**, not `update_item`: `{pk, sk: D, count: <the
   recomputed number>, updated_at: <now>}` — no `ttl`: metric rows are kept indefinitely — plus
   `metric_type` for the source and persona partitions (the `metric_type` GSI is how
   `/metrics/sources` and `/metrics/personas` find them). For the average row, write
   `sum` and `count` from the scored items of `D`.
3. **Any date with feedback can be rebuilt.** Metric rows no longer expire, so there
   is no retention window to stay inside; on a deployment migrated from the old 90-day
   TTL, rebuilding older dates is how their missing rows are restored.
4. **Zero the rows the rebuild did not write** for a date it did rebuild — `put_item`
   them with `count: 0` rather than deleting them (nothing in the data lake is deleted).
   A bucket that has legitimately dropped to zero items still has a row holding its old
   count, and writing only the buckets that now have items leaves that stale row behind.

Do this against a copy of the table first if the window is wide: steps 2 and 4
overwrite counters by design, and they are the only steps that do.

`voc-datalake/scripts/retention/rebuild_aggregates.py` implements exactly this
procedure (same CLI as `remove_ttl.py`: `--stack`/`--region` or explicit table names,
`--from`/`--to` to limit the window). It is a DRY RUN unless `--apply` is passed and
prints a per-dimension summary, including whether the sum of the daily totals equals
the dated items. Two guards make it safe beside the live aggregator: `--apply`
refuses while any item was processed within `--settle-hours` (default 24, the stream
retention — such an item's INSERT may still be in flight and would be counted
twice), and every put is conditional on the row being unchanged since the run
started, so an aggregator write that lands mid-run is reported, not overwritten (a
re-run recomputes it). No dedupe claim is needed: the aggregator's claim is per
stream record and the rebuild consumes none. A re-run writes only rows whose stored
value differs, so it is idempotent and resumable.

## Monitoring

### Metrics

| Metric | Description |
|--------|-------------|
| `FeedbackProcessed` | Total items processed |
| `FeedbackProcessedWithLLM` | Items with successful LLM enrichment |
| `FeedbackProcessedWithoutLLM` | Items where LLM failed |
| `ValidationFailures` | Messages that failed validation |
| `DuplicatesSkipped` | Duplicate items skipped |
| `BedrockThrottleRetry` | Bedrock throttling events |

Aggregator metrics (one per behaviour, so a reversal is not invisible behind an
insert):

| Metric | Description |
|--------|-------------|
| `AggregatesUpdated` | Arrivals applied |
| `AggregatesReversed` | Deletions reversed out |
| `AggregatesRebucketed` | Edits that moved a counter |
| `AggregateWriteRefused` | Conditional writes DynamoDB refused (nothing to correct) |
| `AggregateWriteDeclined` | Writes the handler chose not to attempt |
| `AggregateRecordReplayed` | Redelivered stream records the dedupe claim refused |
| `AggregateTransactionConflicted` | Transactions re-attempted after contention or throttling on a shared row |

### Logs

View processing logs in:
- CloudWatch Logs (Lambda function logs)
- Settings → Logs (validation and processing errors)

## Performance

### Batch Processing

The processor handles SQS messages in batches of up to 10, gathered for at most
5 s (the event source's batching window). The records of a batch are enriched
5 at a time (`ENRICHMENT_CONCURRENCY`), so a full batch takes about two records'
worth of enrichment rather than ten. Each record still succeeds or fails on its
own: a failed or throttled record is reported in `batchItemFailures` and
retried by SQS, and its neighbours are kept.

### Cold Start

First invocation may be slower due to:
- Lambda cold start
- Loading categories from DynamoDB
- Bedrock model initialization

### Throughput

Typical processing time per item:
- Validation: ~10ms
- Language detection: ~100ms
- Translation (if needed): ~200ms
- LLM enrichment: ~1-3 seconds
- DynamoDB write: ~50ms
