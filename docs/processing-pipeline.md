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
text_hash = md5(text[:500])
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

The processor uses AWS Lambda Powertools idempotency to prevent duplicate processing:

- Idempotency key: `{source_platform}:{source_id}`
- Records cached for 1 hour
- Prevents duplicate writes on SQS retries

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
