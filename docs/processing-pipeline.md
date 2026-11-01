# Processing Pipeline

Every piece of feedback, whatever its source, passes through the same pipeline: it is archived to
S3, queued, validated, de-duplicated, enriched with Amazon Comprehend, Amazon Translate and Amazon
Bedrock, stored in DynamoDB and counted into the daily metrics. This document is for operators
and developers who need to understand, tune or repair that flow. Producers are described in
[Plugin Architecture](plugin-architecture.md); the tables and keys in
[Data Lake Structure](data-lake-structure.md).

## Overview

```
Plugin ingestors, webhooks,      ┌──────────────────────┐     ┌───────────────────────┐
manual / CSV / S3 import,   ───▶ │ voc-processing-queue │ ──▶ │ voc-feedback-processor│ ──▶ voc-feedback
feedback forms, email inbox      └──────────┬───────────┘     │ validate, de-dupe,    │        │
        │                                   │ 3 receives      │ Comprehend, Translate,│        │ DynamoDB stream
        ▼                                   ▼                 │ Bedrock               │        ▼
  raw/<source>/… (S3)              voc-processing-dlq         └───────────────────────┘  voc-aggregation-processor
                                                                                               │
                                                                                               ▼
                                                                                         voc-aggregates (METRIC#…)
```

Reviews from a Radar source (a message with `radar_brand_key`) are stored in `voc-radar` instead
of `voc-feedback` and never reach the aggregates ([radar.md](radar.md)).

## Step 1: Ingestion

Producers archive the raw item to S3, apply the source's PII policy
([source-policies.md](source-policies.md)) and send a normalized message to
`voc-processing-queue`. A typical message:

```json
{
  "id": "source_unique_id",
  "source_platform": "webscraper",
  "source_channel": "review",
  "text": "The feedback content",
  "rating": 4.5,
  "created_at": "2026-01-08T10:30:00Z",
  "ingested_at": "2026-01-08T10:35:00Z",
  "brand_name": "Example Air",
  "url": "https://www.example-air.com/reviews/123",
  "s3_raw_uri": "s3://voc-raw-data-<account>-<region>/raw/webscraper/2026/01/08/abc123.json"
}
```

The queue is KMS-encrypted and refuses non-TLS access. Its visibility timeout is 6 times the
processor timeout plus the batching window (1,805 seconds). A message received 3 times without
success moves to `voc-processing-dlq`, which keeps it for 14 days.

## Step 2: Message validation

Every message is validated against `IngestMessage` in `lambda/shared/ingest_schemas.py`, which is
bundled with the processor. If the schema cannot be imported, the processor fails at cold start
instead of running unvalidated. Unknown fields are rejected, so every field a producer sends is
declared. `plugins/_shared/test/test_schemas.py::TestProducerShapes` pins one message per producer
(webscraper, app reviews iOS/Android, s3_import, synthetic_reviews, GitHub webhook, manual-import
confirm/CSV/JSON, feedback-form submit); when you add a field to a producer, add it to that case.

| Field | Rule |
|-------|------|
| `id` | Required, non-blank, max 256 chars |
| `source_platform` | Required, non-blank display name, max 256 (for example `MyApp_iOS`, `S3 - surveys`, a scraper's name) |
| `text` | Required, max 50,000 chars; control characters removed |
| `created_at` | Not more than 1 day in the future. A blank or unparseable value (s3_import's `""`, a scraped "3 days ago") falls back to `ingested_at`, else now |
| `rating` | Optional, 1-10 (the feedback widget's numeric scale is 1-10) |
| `url`, `source_url` | Optional, http/https, max 4,096 |
| `source_channel` | Optional, max 128 (`form_<form id>` for feedback forms) |
| `ingestion_method`, `source_origin`, `manual_import_job_id` | Optional manual-import provenance (64 / 256 / 256) |
| `preset_category`, `preset_subcategory` | Optional feedback-form routing, max 128 |
| `metadata` | Flat primitives, plus `custom_fields`: ≤ 20 scalar answers, keys ≤ 64, values ≤ 1,000 |
| `dimensions` | Optional, ≤ 10 entries, keys ≤ 32, values ≤ 64 ([dimensions.md](dimensions.md)) |

The full field list is in [Plugin Architecture → The queue message contract](plugin-architecture.md#the-queue-message-contract).

### Validation failures

A message that fails validation is:

- logged to the aggregates table (`LOGS#validation#<source>`, 7-day TTL) and counted in the
  `ValidationFailures` metric;
- failed as a batch item (`MessageRejectedError`), so SQS keeps it and, after 3 receives, moves it
  to the processing DLQ for inspection and re-drive. It is never deleted;
- listed under **Administration → System → Logs**.

The aggregator's DynamoDB stream source likewise retries a failing batch 3 times and then records
the discarded shard range on the `voc-aggregator-stream-failures` queue instead of dropping it.

## Step 3: De-duplication

The processor derives a deterministic feedback id from the message:

```python
# The source provides an id
feedback_id = sha256(f"{source_platform}:{source_id}")[:FEEDBACK_ID_LENGTH]

# Fallback for content without an id
text_hash = sha256(text[:500])[:16]
feedback_id = sha256(f"{source_platform}:{created_at}:{text_hash}:{url}")[:FEEDBACK_ID_LENGTH]
```

Before any Comprehend, Translate or Bedrock call, the processor checks whether that item is
already stored. A duplicate is skipped (`DuplicatesSkipped`). Two kinds of message update the
stored item in place instead: an issue-tracker item whose content changed (`github_issues`), and a
CSV dataset row the uploader confirmed as an update ([csv-import.md](csv-import.md)).

## Step 4: Language processing

- **Language detection:** Amazon Comprehend detects the original language.
- **Translation:** if it differs from the primary language (default English), Amazon Translate
  translates the text.
- **Sentiment:** Comprehend provides a baseline label (positive, negative, neutral, mixed) and
  score (-1.0 to 1.0).

Comprehend and Translate receive at most 5,000 characters of text.

## Step 5: LLM enrichment

The processor asks Bedrock (the `enrichment` model surface, Claude Haiku 5.5 by default) for
structured fields. The prompts are `SYSTEM_PROMPT` and `USER_PROMPT_TEMPLATE` in
`lambda/shared/categorization.py`, shared with the category reprocess worker. The feedback text is
wrapped in `<reviews>` tags and the system prompt tells the model to treat it as data, never as
instructions. At most 3,000 characters of text go into the prompt.

### Extracted fields

| Field | Description |
|-------|-------------|
| `category` | Feedback category (from the configured list) |
| `subcategory` | More specific classification |
| `journey_stage` | awareness, consideration, purchase, delivery, usage, support, retention, advocacy, unknown |
| `sentiment_label` | positive, neutral, negative, mixed |
| `sentiment_score` | -1.0 to 1.0 |
| `urgency` | low, medium, high |
| `impact_area` | product, operations, cx, tech, pricing, brand, legal, other |
| `problem_summary` | Brief description of the issue |
| `problem_root_cause_hypothesis` | Potential root cause |
| `direct_customer_quote` | Key quote from the feedback |
| `persona` | Inferred persona: name, type (existing_customer, prospect, churn_risk, advocate, unknown), segment, confidence |

When dimensions are configured, the same call also infers their values.

### Categories

Categories are read from the aggregates table (`SETTINGS#categories`) and cached for 5 minutes.
Configure them in **Administration → Taxonomy → Categories**, where each category is also mapped
to a product and its owners ([categories.md](categories.md)). Changes apply to new feedback within
the cache period. To re-categorize stored feedback, use **Reprocess existing feedback** in the same
editor ([Categories → Reprocess](categories.md#reprocessing-existing-feedback)).

Without a configuration the categories are:

```
delivery | customer_support | product_quality | pricing |
website | app | billing | returns | communication | other
```

### Changing the model

Model selection is configuration-driven; do not set `BEDROCK_MODEL_ID` on a Lambda. In
**Administration → AI models** (`/admin?tab=ai`), an administrator chooses a curated Claude model
per surface. `lambda/shared/model_config.py` applies those choices to every caller.

For accounts that can invoke only one model, pin the deployment-wide default at deploy time:

```bash
cdk deploy --all -c defaultModelId=global.anthropic.claude-sonnet-4-6
```

The id must be in the curated allowlist, the pin is write-once, and later per-surface admin choices
still take precedence. See [Pinning All AI Surfaces to One Model](deployment.md#pinning-all-ai-surfaces-to-one-model).

## Step 6: Storage

The enriched item is written to `voc-feedback`.

### Primary key

```
pk: SOURCE#{brand_name, else source_platform}
sk: FEEDBACK#{feedback_id}
```

Producers send the deployment's brand name, so most items share one `SOURCE#<brand>` partition.
Query by source through `source_platform`, not by `pk`.

### Index keys

```
gsi1pk: DATE#{processing date}      gsi1sk: {processing timestamp}#{feedback_id}
gsi2pk: CATEGORY#{category}         gsi2sk: {sentiment_score}#{processing timestamp}
gsi3pk: URGENCY#{urgency}           gsi3sk: {processing timestamp}
```

The date index is keyed by when the item was processed, not by `created_at`. The indexes are
listed in [Data Lake Structure → Feedback table indexes](data-lake-structure.md#feedback-table-indexes).

## Error handling

### Bedrock throttling

`shared/converse.py` retries a throttled call with exponential backoff, up to 5 attempts. If
Bedrock is still throttling, the record fails (`BedrockThrottleRetry`), is logged to
`LOGS#processing#<source>` and returns to the queue; SQS retries it after the visibility timeout.

### Processing errors

Other errors are logged to the aggregates table (`LOGS#processing#<source>`, 7-day TTL) and shown in
**Administration → System → Logs**. The record fails and SQS retries it.

## Idempotency

Both consumers de-duplicate against the `voc-idempotency` table, because their event sources
deliver at least once.

### Processor (SQS)

AWS Lambda Powertools idempotency:

- Idempotency key: `{source_platform}:{source_id}`, plus a content fingerprint for issue-tracker
  records
- Records kept for 1 hour
- Prevents duplicate writes on SQS retries

Without `IDEMPOTENCY_TABLE` the processor logs a warning and runs without this protection.

### Aggregator (DynamoDB Streams)

The aggregator applies one counter update per dimension (`counter_dimensions` in
`voc-datalake/lambda/aggregator/handler.py`; the number varies with the item and the list is
designed to be extended) plus a running average per feedback record. Its event source is
configured with `retryAttempts: 3` and `reportBatchItemFailures: true`, so a batch that partially
fails re-presents records whose writes already landed. Because these counters are only ever
incremented, that divergence would be permanent.

An **arrival** (`INSERT`) therefore claims the stream record's `eventID` in the idempotency table
inside the *same* `TransactWriteItems` as its counters:

- Idempotency key: `aggregator#stream#{eventID}` (namespaced, since the table is shared with the
  processor)
- Claims expire after 48 hours, longer than the 24 hours a stream record can survive
- A redelivered record cancels the transaction and changes nothing
- A record that fails partway leaves *nothing* applied, so the daily total cannot disagree with
  the sum of the per-category counts

A **reversal** (`REMOVE`, and the decrement half of a `MODIFY`) is *not* transacted, by design.
Every decrement is a conditional write (`attribute_exists(pk) AND #field >= :floor`) whose refusal
the code reads to decide what to do next, while `TransactWriteItems` reports no per-item outcome:
one refused item cancels the whole transaction. So a redelivered reversal still decrements a second
time, bounded by that floor: no counter goes negative and no expired row is recreated.
`AggregateRecordReplayed` in CloudWatch counts the arrivals the claim refused.

A **run of consecutive `REMOVE` records** in one batch (a bulk delete) is reversed together: one
conditional `update_item` per distinct counter (`-n` under `#field >= n`) and one per day for the
average, instead of one per record. The result is the same as one at a time: the combined write is
kept only when its outcome is every record's (the row held all `n`, or there is no row at all); a
row below `n`, or a failed request, falls back to one `-1` per record in record order. An `INSERT`
or `MODIFY` ends the run, and each record still succeeds or fails on its own
(`_RunCoalescingProcessor`; pinned against moto by `aggregator/test/test_removal_run.py`).

A **run of consecutive `INSERT` records** (a bulk import) is applied in joint transactions. Each
carries every record's dedupe claim plus ONE increment per distinct counter, summed over the
records (`+n`), and one average increment per day (the scores summed in DynamoDB's own decimal
context, `count + n`), packed so a transaction stays within DynamoDB's 100 items. Exactly-once is
unchanged, because each record's claim commits in the same transaction as the sums that include
it. When a cancellation names refused claims (records an earlier delivery applied), those records
are reported "already applied" and the rest is re-sent; contention backs off as the one-record path
does; anything else (a validation error, contention past `TRANSACT_WRITE_ATTEMPTS`, a sum that
would round) applies the group's records one at a time through the one-record path, so a poison
record still fails alone. A record with no `eventID` or a non-numeric score goes through the
one-record path up front. Records are joined only when `IDEMPOTENCY_TABLE` is set
(`aggregator/test/test_arrival_run.py`).

#### What a transaction costs, and where contention shows up

- **An arrival costs a little over twice the write capacity, billed on two tables.** DynamoDB
  charges a transactional write at 2× the WCU of the same write sent on its own, and the
  transaction adds the dedupe claim, which lands in the idempotency table. On the aggregates table
  an arrival costs `(counter_dimensions + 1) × 2` WCU (one write per dimension plus the average); on
  the idempotency table, `1 × 2`. The total is `(counter_dimensions + 2) × 2` WCU. Both tables are
  on-demand, so this is cost, not a capacity limit.
- **Same-date records contend.** Every record of a date moves `METRIC#daily_total`, and
  `TransactWriteItems` conflicts on a contended item where two plain `update_item`s would have
  serialized. A bulk import (the `s3_import` plugin, or `TRIM_HORIZON` after a redeploy) produces
  this at volume. The same shape produces throttling, which for a transaction arrives as a
  cancellation carrying a `ThrottlingError` reason, so botocore's own retry policies never match it.

Contention converges rather than losing records, and it is bounded in three places. The
transaction is re-attempted in process with a jittered backoff when the cancellation is transient
(contention or throttling, the reasons in `_RETRYABLE_CANCELLATION_REASONS`, never a validation
failure), up to `TRANSACT_WRITE_ATTEMPTS = 3`, with waits of 25-50 ms and then 50-100 ms. Past that
bound the stream redelivers the record. The claim makes every one of those retries a no-op if an
earlier attempt landed.

`AggregateTransactionConflicted` in CloudWatch is the number to watch, since a retry that succeeds
is otherwise invisible.

**Why bulk imports conflict.** An import writes many feedback partitions, so the stream has many
shards and Lambda runs one invocation per shard at once. Every record of the import day touches the
same rows (`METRIC#daily_total`, the day's sentiment average, its sentiment and category
counters), and two transactions on one item at the same moment cancel with `TransactionConflict`.
The joint arrival transactions above reduce this: on a batch of 100 same-day arrivals, 100
transactions become 2, 839 aggregate-row writes become 64, and the transactions touching
`METRIC#daily_total` go from 100 to 2 (`test_arrival_run.py` pins the numbers). If the metric still
climbs during an import, the levers are the event source's `batchSize` (currently 100; larger
batches join more records per transaction), `maxBatchingWindow` (30 seconds) and
`parallelizationFactor` (keep the default 1: a higher value runs more concurrent invocations per
shard on the same rows) in `voc-datalake/lib/stacks/processing-stack-consolidated.ts`. Do not widen
the transaction: that would put the conditional reversal writes inside it and remove the protections
described above.

## Rebuilding aggregates for a window

Aggregate rows are pre-computed counters, so drift already stored stays stored. The idempotency
above stops new drift but repairs nothing written earlier. There is no scheduled reconciliation
job; the procedure below is the supported repair.

**Write absolute values. Never replay deltas.** The counter updates use
`SET #field = if_not_exists(#field, :zero) + :inc`, so a delta replayed against a missing row (a
legacy row that aged out under the old 90-day TTL, or one never written) *recreates* that row with a
negative count, which `/metrics/summary` would then serve as that day's figures. An absolute `PUT`
cannot do that: it either overwrites a row that is there or writes the correct value for a row that
is not.

For each date `D` in the window:

1. **Recompute from source.** Query the feedback table for the items of `D` and count them per
   dimension: total, `source_platform`, `category`, `sentiment_label`, `persona_type` bucket,
   `urgency == 'high'`, the category+sentiment pair and the other entries of `counter_dimensions`
   in `voc-datalake/lambda/aggregator/handler.py`. Read the dimensions and their pk spellings from
   there rather than re-deriving them: a rebuild that buckets differently from the writer produces
   rows the read path cannot find.
2. **Write each row with `put_item`**, not `update_item`: `{pk, sk: D, count: <the recomputed
   number>, updated_at: <now>}`, with no `ttl` (metric rows are kept indefinitely), plus
   `metric_type` for the source and persona partitions (the `metric_type` index is how
   `/metrics/sources` and `/metrics/personas` find them). For the average row, write `sum` and
   `count` from the scored items of `D`.
3. **Any date with feedback can be rebuilt.** Metric rows do not expire, so there is no retention
   window to stay inside. On a deployment migrated from the old 90-day TTL, rebuilding older dates
   restores their missing rows.
4. **Zero the rows the rebuild did not write** for a date it did rebuild: `put_item` them with
   `count: 0` rather than deleting them. A bucket that has dropped to zero items still has a row
   holding its old count, and writing only the buckets that now have items leaves that stale row.

If the window is wide, do this against a copy of the table first: steps 2 and 4 overwrite counters
by design, and they are the only steps that do.

`voc-datalake/scripts/retention/rebuild_aggregates.py` implements this procedure (same CLI as
`remove_ttl.py`: `--stack`/`--region` or explicit table names, `--from`/`--to` to limit the window).
It is a dry run unless `--apply` is passed, and prints a per-dimension summary, including whether
the sum of the daily totals equals the dated items. Two guards make it safe beside the live
aggregator: `--apply` refuses while any item was processed within `--settle-hours` (default 24, the
stream retention: such an item's INSERT may still be in flight and would be counted twice), and
every put is conditional on the row being unchanged since the run started, so an aggregator write
that lands mid-run is reported, not overwritten (a re-run recomputes it). No dedupe claim is needed:
the aggregator's claim is per stream record and the rebuild consumes none. A re-run writes only rows
whose stored value differs, so it is idempotent and resumable.

## Monitoring

### Metrics

Processor metrics (CloudWatch namespace `VoC`):

| Metric | Description |
|--------|-------------|
| `FeedbackProcessed` | Items processed and stored |
| `FeedbackProcessedWithLLM` | Items with successful LLM enrichment |
| `FeedbackProcessedWithoutLLM` | Items stored without LLM fields because enrichment failed |
| `ValidationFailures` | Messages that failed validation |
| `DuplicatesSkipped` | Duplicate items skipped |
| `IdempotencySkipped` | Records skipped because the same record was already in progress |
| `BedrockThrottleRetry` | Records returned to the queue after Bedrock throttling |
| `SourceUpdatesApplied` | Stored issue-tracker items refreshed in place |
| `RadarFeedbackProcessed` | Radar reviews stored in `voc-radar` |

Aggregator metrics (one per behaviour, so a reversal is not hidden behind an insert):

| Metric | Description |
|--------|-------------|
| `AggregatesUpdated` | Arrivals applied |
| `AggregatesReversed` | Deletions reversed out |
| `AggregatesRebucketed` | Edits that moved a counter |
| `AggregateWriteRefused` | Conditional writes DynamoDB refused (nothing to correct) |
| `AggregateWriteDeclined` | Writes the handler chose not to attempt |
| `AggregateRecordReplayed` | Redelivered stream records the dedupe claim refused |
| `AggregateTransactionConflicted` | Transactions re-attempted after contention or throttling on a shared row |

### Logs and alarms

- CloudWatch Logs: `/aws/lambda/voc-feedback-processor-<account>-<region>` and
  `/aws/lambda/voc-aggregation-processor-<account>-<region>`.
- **Administration → System → Logs**: validation and processing errors, and **System errors**
  (every Lambda ERROR and timeout from CloudWatch, grouped; [deployment.md](deployment.md)).
- **Administration → System → Logs → Alerts** creates CloudWatch alarms on the processor and
  aggregator errors, the processing DLQ and the stream-failure queue. None exists until an
  administrator turns alerting on.

## Performance

The processor reads SQS messages in batches of up to 10, gathered for at most 5 seconds, with at
most 20 concurrent invocations. The records of a batch are enriched 5 at a time
(`ENRICHMENT_CONCURRENCY`), so a full batch takes about two records' worth of enrichment rather than
ten. Each record succeeds or fails on its own: a failed or throttled record is reported in
`batchItemFailures` and retried by SQS, and its neighbours are kept. The processor runs with a
5-minute timeout and 1,769 MB (one vCPU). The Bedrock call dominates the time per item.

The aggregator reads the feedback table's stream in batches of up to 100 records, gathered for at
most 30 seconds, from `TRIM_HORIZON`, and bisects a failing batch to isolate a poison record.
