# VoC Data Lake - System Documentation

Complete technical documentation for the Voice of Customer Data Lake platform. This document consolidates all detailed architecture, feature, and implementation documentation.

## Table of Contents

- [Data Lake Structure](#data-lake-structure)
- [Processing Pipeline](#processing-pipeline)
- [Plugin Architecture](#plugin-architecture)
- [Creating Plugins](#creating-plugins)
- [Mobile App Reviews Plugins](#mobile-app-reviews-plugins)
- [Web Scrapers](#web-scrapers)
- [Feedback Forms](#feedback-forms)

---

## Data Lake Structure

### Overview

The VoC platform stores data in two primary locations:

1. **S3 Raw Data Bucket** - Immutable raw data from all sources
2. **DynamoDB Tables** - Processed, queryable feedback data

### S3 Raw Data Structure

Raw data is stored in S3 with a partitioned folder structure:

```
s3://voc-raw-data-bucket/
└── raw/
    └── {source_platform}/
        └── {year}/
            └── {month}/
                └── {day}/
                    └── {item_id}.json
```

Example paths:
```
raw/webscraper/2026/01/08/abc123def456.json
raw/feedback_form/2026/01/08/uuid-here.json
```

### Raw Data File Format

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
    "url": "https://source.com/review/123",
    "author": "John D."
  }
}
```

### Partitioning Strategy

Data is partitioned by:
1. **Source platform** - Isolates data by origin
2. **Date** - Year/month/day hierarchy for efficient queries
3. **Item ID** - Deterministic filename prevents duplicates


### DynamoDB Global Secondary Indexes

#### Feedback Table GSIs

| GSI | Partition Key | Sort Key | Use Case |
|-----|---------------|----------|----------|
| GSI1 | `DATE#{date}` | `{timestamp}#{id}` | Query by date |
| GSI2 | `CATEGORY#{category}` | `{score}#{timestamp}` | Query by category |
| GSI3 | `URGENCY#{urgency}` | `{timestamp}` | Query urgent items |

#### Aggregates Table Key Patterns

| Key Pattern | Description |
|-------------|-------------|
| `SETTINGS#*` | Configuration data |
| `LOGS#*` | Processing logs |
| `SCRAPER_RUN#*` | Scraper execution history |
| `FEEDBACK_FORM` | Form configurations |

### Data Explorer

The Data Explorer provides a UI for browsing and managing data lake contents:

- **S3 Browser**: Navigate folders, preview files, edit JSON
- **Feedback Editor**: View and modify processed feedback
- **Sync**: Push changes between S3 and DynamoDB

### Querying Patterns

```python
# By Date Range
response = table.query(
    IndexName='gsi1',
    KeyConditionExpression='gsi1pk = :pk',
    ExpressionAttributeValues={':pk': f'DATE#2026-01-08'}
)

# By Category
response = table.query(
    IndexName='gsi2',
    KeyConditionExpression='gsi2pk = :pk',
    ExpressionAttributeValues={':pk': 'CATEGORY#product_quality'}
)

# By Source
response = table.query(
    KeyConditionExpression='pk = :pk',
    ExpressionAttributeValues={':pk': 'SOURCE#webscraper'}
)
```

### Retention

- **S3 Raw Data**: Retained indefinitely (configure lifecycle rules as needed)
- **DynamoDB Feedback**: 1 year TTL (configurable)
- **Processing Logs**: 7 days TTL

---

## Processing Pipeline

### Overview

The processing pipeline transforms raw feedback into enriched, queryable data:

```
Plugin Ingestor → S3 Raw Storage → SQS Queue → Processor Lambda (Bedrock + Comprehend) → DynamoDB
```

### Step 1: Ingestion

Plugins fetch data from external sources:
1. Fetch new items from the data source API
2. Store raw data to S3 (immutable archive)
3. Normalize to standard message format
4. Send to SQS for processing

### Step 2: Message Validation

Messages are validated using Pydantic schemas before processing:

| Field | Rule |
|-------|------|
| `id` | Required, max 256 chars |
| `source_platform` | Required, lowercase alphanumeric |
| `text` | Required, max 50KB |
| `created_at` | Required, valid ISO 8601, not future |
| `rating` | Optional, 1-5 range |
| `url` | Optional, must be http/https |

Failed messages are logged to DynamoDB (`LOGS#validation#{source}`) and removed from queue.

### Step 3: Deduplication

Deterministic IDs prevent duplicate entries:
- If source provides an ID: `hash(f"{source_platform}:{source_id}")`
- Fallback for scraped content: `hash(f"{source_platform}:{created_at}:{sha256(text[:500])}:{url}")`

### Step 4: Language Processing

1. **Language Detection**: Amazon Comprehend detects the original language
2. **Translation**: Amazon Translate translates if language differs from primary (default: English)
3. **Sentiment Analysis**: Comprehend provides baseline sentiment (label + score -1.0 to 1.0)

### Step 5: LLM Enrichment

Amazon Bedrock (Claude) extracts structured insights:

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

### Step 6: Storage

Processed feedback stored in DynamoDB with multiple access patterns:

```
pk: SOURCE#{source_platform}    sk: FEEDBACK#{feedback_id}
gsi1pk: DATE#{date}             gsi1sk: {timestamp}#{id}
gsi2pk: CATEGORY#{cat}          gsi2sk: {score}#{timestamp}
gsi3pk: URGENCY#{urgency}       gsi3sk: {timestamp}
```

### Categories Configuration

Categories are loaded from DynamoDB (`SETTINGS#categories`). Configure via Settings → Categories.

Default categories: `delivery | customer_support | product_quality | pricing | website | app | billing | returns | communication | other`

### Error Handling

- **Bedrock Throttling**: Exponential backoff retry (up to 5 attempts), then message stays in SQS for later retry
- **Processing Errors**: Logged to DynamoDB (`LOGS#processing#{source}`) and visible in Settings → Logs

### Idempotency

Uses AWS Lambda Powertools idempotency:
- Key: `{source_platform}:{source_id}`
- Records cached for 1 hour
- Prevents duplicate writes on SQS retries

### Performance

| Step | Typical Time |
|------|-------------|
| Validation | ~10ms |
| Language detection | ~100ms |
| Translation (if needed) | ~200ms |
| LLM enrichment | ~1-3 seconds |
| DynamoDB write | ~50ms |

### Monitoring Metrics

| Metric | Description |
|--------|-------------|
| `FeedbackProcessed` | Total items processed |
| `FeedbackProcessedWithLLM` | Items with successful LLM enrichment |
| `FeedbackProcessedWithoutLLM` | Items where LLM failed |
| `ValidationFailures` | Messages that failed validation |
| `DuplicatesSkipped` | Duplicate items skipped |
| `BedrockThrottleRetry` | Bedrock throttling events |


---

## Plugin Architecture

### Why Plugins?

1. **Self-contained**: Each connector lives in its own folder with everything it needs
2. **Single source of truth**: One `manifest.json` drives both infrastructure deployment and UI rendering
3. **Easy to contribute**: Drop a folder, deploy, done
4. **Enable/disable without redeploy**: Runtime toggle via Settings UI

### Architecture Flow

```
Plugin Folder (manifest.json + handler.py)
    ↓
CDK Plugin Loader (validates manifests with Zod, verifies code integrity)
    ↓
Creates: Lambda functions, EventBridge schedules, API Gateway webhook routes
    ↓
Frontend Build (generates manifests.json for Settings page)
```

### Shared Plugin Modules (`_shared/`)

| Module | Purpose |
|--------|---------|
| `base_ingestor.py` | Base class: secrets loading, watermarks, S3 storage, SQS batching, circuit breaker |
| `base_webhook.py` | Base class: body parsing, normalization, SQS sending, error handling |
| `circuit_breaker.py` | Auto-disables plugins after 5 failures in 15 minutes |
| `audit.py` | Structured audit logging + EventBridge events |
| `schemas.py` | Pydantic message validation (sanitization, constraints) |

### Manifest Schema

```json
{
  "id": "your_source_id",
  "name": "Display Name",
  "icon": "🔌",
  "description": "Brief description",
  "category": "reviews",
  "version": "1.0.0",
  "infrastructure": {
    "ingestor": { "enabled": true, "schedule": "rate(15 minutes)", "timeout": 120, "memory": 256 },
    "webhook": { "enabled": false },
    "s3Trigger": { "enabled": false }
  },
  "config": [{ "key": "api_key", "label": "API Key", "type": "password", "required": true, "secret": true }],
  "setup": { "title": "Setup", "color": "blue", "steps": ["Step 1", "Step 2"] },
  "secrets": { "api_key": "" }
}
```

### Manifest Limits (Enforced at Load Time)

| Limit | Value |
|-------|-------|
| Timeout | max 300 seconds |
| Memory | max 1024 MB |
| Schedule | min 1 minute |
| Config fields | max 20 |
| Setup steps | max 15 |
| Webhook info | max 5 |
| S3 trigger suffixes | max 5 |

### Infrastructure Isolation

Plugins declare what they need; the platform creates resources using controlled templates.

**What plugins CAN declare**: Polling Lambda, Webhook Lambda, S3 Trigger, Secrets, Schedule

**What plugins CANNOT do**: Create IAM roles, DynamoDB tables, S3 buckets, VPCs, or arbitrary CloudFormation

All plugin Lambdas share a single tightly-scoped IAM role with permissions for: SQS (processing queue), Secrets Manager, S3 (raw bucket), DynamoDB (watermarks + aggregates), KMS.

### Secrets Isolation

Secrets are prefixed with plugin ID for isolation. At runtime, `BaseIngestor._load_secrets()` strips the prefix so plugins access secrets by clean key name.

### Lambda Bundling

Each plugin Lambda bundles three code sources:
1. Plugin's own `ingestor/` or `webhook/` code
2. `plugins/_shared/` (base classes, circuit breaker, audit, schemas)
3. `lambda/shared/` (logging, AWS client helpers, HTTP utilities)

Runtime: Python 3.14 on ARM64 (Graviton). Each plugin gets its own CloudWatch Log Group with 2-week retention.

### Enable/Disable Flow

1. **Deploy time**: `pluginStatus` in `cdk.context.json` controls which plugins get AWS resources
2. **Runtime**: Settings UI toggles EventBridge rules on/off via API
3. **No redeploy needed** to enable/disable a deployed plugin

### Message Schema (Output Contract)

Required fields: `id` (1-256 chars), `source_platform` (lowercase alphanumeric), `text` (1-50,000 chars), `created_at` (ISO 8601, not >1 day future)

Optional fields: `rating` (1.0-5.0), `url` (max 2048, http/https), `channel` (max 64), `author` (max 256), `title` (max 500), `language` (ISO code), `brand_handles_matched` (max 10), `metadata` (flat primitives only), `source_platform_override`

### Code Integrity Verification

Optional SHA-256 verification of plugin code. Generate hashes with `npx ts-node scripts/generate-integrity.ts`.

---

## Creating Plugins

### Step-by-Step

1. Copy the template: `cp -r plugins/_template plugins/your_source_id`
2. Update `manifest.json` with source details
3. Implement `fetch_new_items()` in `ingestor/handler.py`
4. Enable in `cdk.context.json`: `"pluginStatus": { "your_source_id": true }`
5. Generate manifests and deploy: `npm run generate:config && cdk deploy VocIngestionStack`
6. Validate (optional): `npm run validate:plugins`

### Handler Implementation

```python
from typing import Generator
from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics

class YourSourceIngestor(BaseIngestor):
    def __init__(self):
        super().__init__()
        self.api_key = self.secrets.get("api_key", "")

    def fetch_new_items(self) -> Generator[dict, None, None]:
        if not self.api_key:
            logger.warning("No API key configured")
            return
        last_id = self.get_watermark("last_id")
        # Fetch from your API and yield items
        yield {
            "id": "unique_id",
            "text": "Feedback content",
            "rating": 4.5,
            "created_at": "2026-01-08T10:30:00Z",
            "url": "https://source.com/review/123",
            "channel": "review",
            "author": "John D.",
        }

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event, context):
    ingestor = YourSourceIngestor()
    return ingestor.run()
```

### Using Watermarks

```python
last_id = self.get_watermark("last_id")    # Get last processed ID
self.set_watermark("last_id", newest_id)   # Save new watermark
```

### Infrastructure Options

| Type | Config | Description |
|------|--------|-------------|
| Polling Ingestor | `"ingestor": { "enabled": true, "schedule": "rate(15 minutes)" }` | Runs on schedule |
| Webhook Handler | `"webhook": { "enabled": true, "path": "/webhooks/your_source" }` | Real-time events |
| S3 Trigger | `"s3Trigger": { "enabled": true, "suffixes": [".csv", ".json"] }` | File upload events |


---

## Mobile App Reviews Plugins

Design documentation for iOS and Android app review collection plugins.

### Overview

| Plugin | Folder | Source | Identifier |
|--------|--------|--------|------------|
| iOS App Reviews | `plugins/app_reviews_ios/` | Apple App Store | `app_reviews_ios` |
| Android App Reviews | `plugins/app_reviews_android/` | Google Play Store | `app_reviews_android` |

Each plugin is independent with its own Lambda, schedule, secrets, watermarks, and circuit breaker.

### Plugin Structure

```
plugins/
├── app_reviews_ios/
│   ├── manifest.json
│   └── ingestor/
│       ├── handler.py          # IOSAppReviewsIngestor
│       ├── itunes_client.py    # Apple App Store RSS feed client
│       ├── countries.py        # iOS storefront country codes
│       └── models.py           # App config validation
│
└── app_reviews_android/
    ├── manifest.json
    └── ingestor/
        ├── handler.py          # AndroidAppReviewsIngestor
        ├── play_client.py      # Google Play Store scraper client
        ├── countries.py        # Play Store country codes
        └── models.py           # App config validation
```

### Settings UI Fields

**iOS**: App Name, App Store ID, Sort Order (most_recent/most_critical), Max Countries Per Run (default: 40), Max Reviews Per Run (default: 500), Run Frequency

**Android**: App Name, Package Name, Sort Order (newest/rating), Max Countries Per Run (default: 20), Max Reviews Per Run (default: 500), Run Frequency

### Global Collection Strategy

1. Load supported storefront country codes
2. Shuffle country list (fair coverage over time)
3. Limit to `max_countries_per_run`
4. Fetch reviews from each country
5. Merge and deduplicate by stable composite ID
6. Sort by date descending, keep top N
7. Filter out reviews older than watermark
8. Yield to pipeline

### Deduplication

- iOS: `ios_{app_id}_{review_id}`
- Android: `android_{package_name}_{review_id}`

### Watermark Strategy

| Key | Value | Purpose |
|-----|-------|---------|
| `{app_name}_last_published_at` | ISO 8601 timestamp | Newest review from last run |
| `{app_name}_last_run` | ISO 8601 timestamp | When last collection ran |

### Dependencies

- iOS: `app-store-web-scraper>=0.3.0` (Apple iTunes RSS endpoint, built-in rate limiting)
- Android: `google-play-scraper>=1.2.7` (zero external dependencies)

Neither requires native C extensions (ARM64 compatible without Docker builds).

### Supported Countries

- iOS: 40 countries (US, GB, DE, FR, JP, AU, CA, IT, ES, NL, BR, MX, IN, KR, SE, NO, DK, FI, CH, AT, BE, PT, PL, CZ, RU, TR, SA, AE, ZA, SG, HK, TW, TH, MY, PH, ID, VN, CO, CL, AR)
- Android: 20 countries (US, GB, DE, FR, JP, AU, CA, IT, ES, NL, BR, MX, IN, KR, SE, RU, TR, SA, ZA, SG)

### Limitations

- Single app per plugin (multi-app planned)
- Unofficial APIs (circuit breaker auto-disables on endpoint changes)
- iOS max 500 reviews per country (10 pages × 50)
- No authentication required for either source
- Reviews returned in original language (pipeline handles translation)

---

## Web Scrapers

### Overview

Scrapers collect customer feedback from web pages using configurable extraction rules with CSS selectors or JSON-LD structured data.

### Scraper Configuration

```json
{
  "id": "unique_scraper_id",
  "name": "My Scraper",
  "url": "https://example.com/reviews",
  "enabled": true,
  "extraction_method": "css",
  "container_selector": ".review-item",
  "text_selector": ".review-text",
  "rating_selector": ".star-rating",
  "author_selector": ".reviewer-name",
  "date_selector": ".review-date",
  "pagination": { "enabled": true, "param": "page", "max_pages": 10, "start": 1 }
}
```

### Extraction Methods

**CSS Selectors**: Target specific elements with `container_selector`, `text_selector`, `rating_selector`, `author_selector`, `date_selector`.

**JSON-LD**: Automatically extract reviews from structured data: `"extraction_method": "jsonld"`.

### AI-Assisted Configuration

The Analyze URL feature uses AI to automatically detect CSS selectors from any page.

### Templates

| Template | Description |
|----------|-------------|
| `review_jsonld` | Extract from JSON-LD structured data |
| `custom_css` | Custom CSS selector configuration |

### Pagination

```json
{ "pagination": { "enabled": true, "param": "page", "max_pages": 10, "start": 1 } }
```

Appends `?page=1`, `?page=2`, etc. to the URL.

### Security

One outbound-URL policy, in `lambda/shared/http_utils.py`, guards every scraper
request against SSRF. Shared by the API and the plugin — both deployment bundles
already stage `lambda/shared` — so there is one implementation, not one per caller.

Applied at three points:
- **On save**: `POST /scrapers` and `PUT /integrations/webscraper/credentials` (both
  write the same `webscraper_configs` key), so an internal target cannot be scheduled.
- **On preview**: `POST /scrapers/analyze-url`, before anything reaches Bedrock.
- **At fetch time**: the scheduled ingestor re-checks each URL immediately before the
  request, and again for every redirect hop — a saved host can start resolving
  internally after it was approved.

The policy itself:
- Only `http`/`https`; URLs with embedded credentials and `localhost` aliases refused.
- The hostname is resolved and the URL is refused if **any** answer is non-global:
  loopback, private, link-local (including `169.254.169.254`), multicast,
  unspecified, reserved, IPv6 site-local (`fec0::/10`), and IPv4 tunnelled inside
  IPv6 (v4-mapped, 6to4, Teredo).
- Fails closed: a resolver failure, an empty answer, or a mixed public/private answer
  set is a refusal — the HTTP client picks the address from the set, not the platform.
- Redirects are followed by the platform, never by the HTTP client, bounded at 5 hops.
  Credentials (`Authorization`/`Cookie` headers and the `auth=`/`cookies=` options) are
  dropped on exactly the hops `requests.should_strip_auth` drops them on — that call is
  delegated, not reimplemented, so a host or port change and an `https`→`http`
  downgrade drop them while a same-host `http`→`https` upgrade does not. A `Location`
  resolving back to the requesting URL ends the walk instead of consuming the hops.
- Each scheduled page fetch carries a 60 s wall-clock budget as well as a 15 s
  per-request timeout, and the **invocation** as a whole carries a 240 s budget on top
  of it. The Lambda has 300 s, one configuration may name 50 URLs and one invocation
  processes every due configuration, so a per-page bound alone still summed past the
  limit — which loses the final run-status write and leaves the run row at `running`.
  Exhausting the run budget stops the invocation, records how many URLs went
  unattempted in the run's `errors`, and reports `completed_with_errors`. Every
  configuration then stays due for the next schedule: the ones never reached were never
  written, and the truncated one has its watermark **held** — advancing it would mark a
  configuration whose URLs went unattempted as having just run, and since the URL list
  rebuilds in the same order, a persistently slow prefix would starve its own tail on
  every invocation rather than retrying it. That retry re-walks the list from the start
  rather than resuming. A page that never loaded is not counted toward `pages_scraped`,
  so a wholly failed run cannot read as an empty healthy one.
- Staying due is not the same as getting to run, so the truncation is also **recorded**
  and the configuration loop is ordered by it: a configuration that ran out of budget
  last time is visited **last** this time. Without that, the three behaviours above
  compose into a total halt — a configuration held as due is due on every invocation, the
  budget stops the loop, and stored order reached it first every time, so one slow site
  silently halted ingestion for every other scraper in the account (measured: 0 of 2
  healthy configurations reached across 20 scheduled invocations). Configurations that
  have never truncated keep their stored order, and the marker is cleared once a
  configuration gets through all of its URLs, so one slow day does not demote it
  permanently. The marker names the configuration that **spent** the budget, not the one
  that discovered it was gone: a configuration exhausting the budget while still finishing
  its own URL list leaves the next one to find nothing left, and that one has requested
  nothing — so it writes no run row and no watermark, staying due, instead of reporting
  "N URL(s) not attempted" about itself and being demoted in the culprit's place.
  A `ScraperRunBudgetExhausted` metric
  makes a persistently truncating account alertable — for a scheduled run the run row is
  not written at all, so the logs and this metric are the only signal.
- A stored configuration array with no usable entry reports an `error` run instead of
  iterating nothing, so a manual run's row is not abandoned at `running`; an unusable entry
  beside working ones is dropped and logged at ERROR and the working ones still run.
- One unreadable configuration costs that configuration, never the invocation. A missing
  `id`, a `pagination.max_pages` of `'10'`, a non-dict `pagination` or an unparseable
  stored `last_run`/`frequency_minutes` used to raise out of the scraping loop, so **no**
  configuration in the account ingested and a manual run's row was again left at
  `running`. Closed in three places: the write routes refuse those shapes (an actionable
  400 naming the field), the scheduled reader coerces them for values already stored —
  falling back to the same defaults an absent value gets, and treating an unreadable
  schedule as *due* since never running again is the worse direction — and the
  configuration loop catches anything remaining, logs at ERROR, emits
  `ScraperConfigUnusable`, writes a terminal `error` status and continues to the next
  configuration. An unusable configuration records no `last_run`, so fixing it does not
  mean waiting out its frequency.
- `pagination` names no destination — its URLs are built from `base_url` and so carry a
  host already checked — but its **shape** is validated on write, because the scheduled
  reader does arithmetic with those numbers: `max_pages` and `start` must be integers,
  `max_pages` within 1-50, matching the bounds the editor already enforces. That also
  bounds the number of URLs one configuration can cause to be fetched, which the 50-URL
  cap does not: the cap counts URLs a configuration *names*, and pagination multiplies
  them.
- At most 50 URLs per configuration's `urls`, resolved once per distinct host within one
  write — each lookup is synchronous inside a request bounded by API Gateway's 29 s
  limit. Enforced only on a list the write changes, so a pre-existing longer list keeps
  saving and cannot block edits to configurations stored alongside it; its destinations
  are still checked and growing it is refused.

**Residual risk**: the hostname is resolved by the check and again by the HTTP client,
so DNS rebinding across the two lookups is narrowed, not closed. Closing it requires
pinning the validated address, which is not done today.

### Deduplication

- Source-provided ID used directly when available
- Otherwise: hash of `created_at + text_hash + url`

---

## Feedback Forms

### Overview

Embeddable feedback forms for collecting customer feedback directly on websites or applications. Supports multiple forms with different configurations, routes feedback to the processing pipeline.

### Form Configuration Options

| Option | Description |
|--------|-------------|
| `title` | Main heading displayed on the form |
| `description` | Subtitle or context text |
| `question` | The feedback prompt |
| `placeholder` | Placeholder text in the textarea |
| `rating_enabled` | Show/hide rating input |
| `rating_type` | `stars`, `emoji`, or `numeric` |
| `rating_max` | Maximum rating value (default: 5) |
| `collect_email` | Ask for email address |
| `collect_name` | Ask for name |
| `category` | Pre-assign category for all submissions |
| `subcategory` | Pre-assign subcategory |
| `success_message` | Message shown after submission |
| `theme` | Color and styling options |

### Embedding

Embed with an iframe — the Lambda inlines the widget JS into the page, so there
is no separate script to load:

```html
<iframe src="https://your-api/v1/feedback-forms/{form_id}/iframe" width="100%" height="500" frameborder="0"></iframe>
```

The only public per-form routes are `config`, `submit` and `iframe`; there is no
`widget.js` route, and requesting one returns `403 Missing Authentication Token`.
See [Feedback Forms](feedback-forms.md#embedding-forms).

### Pre-Categorization

Forms can auto-assign categories for product-specific, support, or feature request forms.

### Theming

```json
{ "theme": { "primary_color": "#3B82F6", "background_color": "#FFFFFF", "text_color": "#1F2937", "border_radius": "8px" } }
```

### Custom Fields

```json
{
  "custom_fields": [
    { "key": "product_id", "label": "Product", "type": "select", "options": [{"value": "a", "label": "Product A"}] },
    { "key": "order_number", "label": "Order Number", "type": "text", "placeholder": "ORD-12345" }
  ]
}
```

### Processing

Submitted feedback follows the standard pipeline: Form → SQS → Processor Lambda → DynamoDB. The `source_channel` field identifies which form the feedback came from.

### CORS

Feedback form endpoints allow cross-origin requests by default. Restrict origins via the `ALLOWED_ORIGIN` environment variable.
