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

Before processing, messages are validated using Pydantic schemas. For detailed validation implementation including security sanitization, see [Plugin Architecture - SQS Message Validation](plugin-architecture.md#sqs-message-validation-layer).

### Validation Rules

| Field | Rule |
|-------|------|
| `id` | Required, max 256 chars |
| `source_platform` | Required, lowercase alphanumeric |
| `text` | Required, max 50KB |
| `created_at` | Required, valid ISO 8601, not future |
| `rating` | Optional, 1-5 range |
| `url` | Optional, must be http/https |

### Validation Failures

Failed messages are:
- Logged to DynamoDB (`LOGS#validation#{source}`)
- Removed from queue (not retried)
- Visible in Settings → Logs

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

Categories are loaded from DynamoDB (`SETTINGS#categories`). Configure via Settings → Categories.

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
3. Changes take effect immediately (cached for 5 minutes)

### Changing the Model

Set the `BEDROCK_MODEL_ID` environment variable:

```
# Default (cost-efficient for high volume)
BEDROCK_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0

# Higher quality (more expensive)
BEDROCK_MODEL_ID=anthropic.claude-3-sonnet-20240229-v1:0
```

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

The aggregator applies eight counter updates plus a running average per feedback
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

## Rebuilding aggregates for a window

Aggregate rows are pre-computed counters, so any drift already stored stays stored —
the idempotency above stops new drift arriving but repairs nothing written earlier.
There is no scheduled reconciliation job; the procedure below is the supported repair,
and it is short enough that a job would be out of proportion to how rarely it is
needed.

**Write absolute values. Never replay deltas.** The counter updates use
`SET #field = if_not_exists(#field, :zero) + :inc`, so a delta replayed against a row
that has aged out of its 90-day TTL *recreates* that row under a fresh TTL — holding a
negative count for a date whose real totals are long gone, which
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
   recomputed number>, ttl: <now + 90 days>, updated_at: <now>}`, plus
   `metric_type` for the source and persona partitions (the `metric_type` GSI is how
   `/metrics/sources` and `/metrics/personas` find them). For the average row, write
   `sum` and `count` from the scored items of `D`.
3. **Skip dates outside retention.** Aggregate rows live 90 days
   (`AGGREGATE_RETENTION_DAYS`), and rebuilding a date older than that plants rows for
   a day whose neighbours no longer exist — `/metrics/trends` would show one populated
   day in an empty stretch. Rebuild only within the retention window.
4. **Delete rows the rebuild did not write** for a date it did rebuild. A bucket that
   has legitimately dropped to zero items still has a row holding its old count, and
   writing only the buckets that now have items leaves that stale row behind.

Do this against a copy of the table first if the window is wide: step 2 is
destructive by design, and it is the only step that is.

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

### Logs

View processing logs in:
- CloudWatch Logs (Lambda function logs)
- Settings → Logs (validation and processing errors)

## Performance

### Batch Processing

The processor handles SQS messages in batches (up to 10 at a time).

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
