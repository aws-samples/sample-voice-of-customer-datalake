# Mobile App Reviews Plugins

Collect customer reviews from the Apple App Store and Google Play Store using two dedicated plugins.

## Overview

The mobile app reviews feature consists of two separate plugins:

| Plugin | Folder | Source | Identifier |
|--------|--------|--------|------------|
| iOS App Reviews | `plugins/app_reviews_ios/` | Apple App Store | `app_reviews_ios` |
| Android App Reviews | `plugins/app_reviews_android/` | Google Play Store | `app_reviews_android` |

Each plugin is independent — its own Lambda, schedule, secrets, watermarks, and circuit breaker. If one platform has issues, the other continues running.

## Plugin Structure

Each plugin handler subclasses `BaseIngestor` from `_shared/base_ingestor.py`. The import pattern follows the existing webscraper convention:

```python
from _shared.base_ingestor import BaseIngestor, logger, tracer, metrics
```

```
plugins/
├── app_reviews_ios/
│   ├── manifest.json
│   └── ingestor/
│       ├── handler.py          # IOSAppReviewsIngestor (subclasses BaseIngestor)
│       ├── itunes_client.py    # Apple App Store RSS feed client
│       ├── countries.py        # iOS storefront country codes
│       └── models.py           # App config validation (IOSAppConfig dataclass)
│
└── app_reviews_android/
    ├── manifest.json
    └── ingestor/
        ├── handler.py          # AndroidAppReviewsIngestor (subclasses BaseIngestor)
        ├── play_client.py      # Google Play Store scraper client
        ├── countries.py        # Play Store country codes
        └── models.py           # App config validation (AndroidAppConfig dataclass)
```

Both plugins follow the same conventions as the existing `webscraper` plugin:
- `manifest.json` at the plugin root drives CDK infrastructure and frontend UI
- All Python code lives under `ingestor/` for correct Lambda bundling
- Each handler subclasses `_shared/base_ingestor.py`
- Lambda bundling copies plugin code + `_shared/` + `lambda/shared/` (see `ingestion-stack.ts`)

## Scrapers Page UI

Both plugins appear as cards on the **Scrapers** page (**Data Sources**), reached from **Scrapers** in the sidebar — rendered dynamically from their manifests. Open a card (or **New Source** → the plugin) to manage its apps. **Each plugin supports multiple apps**: add, edit, and delete several apps per plugin from the **Configured Apps** list (stored as a JSON array in Secrets Manager via the `/integrations/{source}/apps` CRUD endpoints).

### iOS Plugin Settings

The iOS plugin card shows these config fields:

| Field | Key | Type | Default | Description |
|-------|-----|------|---------|-------------|
| App Name | `app_name` | text | — | Logical app name (required) |
| App Store ID | `app_id` | text | — | Apple App Store numeric ID (required) |
| Review Sort Order | `sort_by` | select | `most_recent` | `most_recent` (the only option — see [Sort Order](#sort-order)) |
| Max Countries Per Run | `max_countries_per_run` | text | `40` | Limit country iteration |
| Max Reviews Per Run | `max_reviews_per_run` | text | `500` | Max reviews to collect per run |
| Run Frequency | `frequency_minutes` | select | `1440` (Daily) | Schedule override |

### Android Plugin Settings

The Android plugin card shows these config fields:

| Field | Key | Type | Default | Description |
|-------|-----|------|---------|-------------|
| App Name | `app_name` | text | — | Logical app name (required) |
| Package Name | `package_name` | text | — | Android package name (required) |
| Review Sort Order | `sort_by` | select | `newest` | `newest` or `rating` |
| Max Countries Per Run | `max_countries_per_run` | text | `20` | Limit country iteration |
| Max Reviews Per Run | `max_reviews_per_run` | text | `500` | Max reviews to collect per run |
| Run Frequency | `frequency_minutes` | select | `1440` (Daily) | Schedule override |

### Run Frequency Options

Both plugins offer the same frequency options via a select dropdown. **Each app connector's own
Run Frequency is honoured**: the ingestor's EventBridge rule ticks every 30 minutes, and on each
scheduled tick an app runs only when its own `frequency_minutes` has elapsed since its
`{app_name}_last_run` (`0` = manual runs only). An app connector saved without one falls back to
the plugin's top-level `frequency_minutes` (default 60). Before 5.44 every app ran on the top-level
value and the per-app choice was ignored. The same holds for **Review Sort Order** (`sort_by`):
the app connector's value wins over the top-level one. "Run now" always runs, whatever the frequency.

| Value | Label |
|-------|-------|
| `0` | Manual only |
| `15` | Every 15 minutes |
| `30` | Every 30 minutes |
| `60` | Every hour |
| `180` | Every 3 hours |
| `360` | Every 6 hours |
| `720` | Every 12 hours |
| `1440` | Daily |

### Sort Order

**iOS options:**
- `most_recent` — Fetch newest reviews first (the default and only option)

There is no "most critical" sort: Apple's customer-reviews RSS feed answers HTTP 500 for
`sortby=mostcritical`, so that option was removed. Filter by rating after ingestion instead.

**Android options:**
- `newest` — Fetch newest reviews first (default, recommended)
- `rating` — Fetch by rating (maps to `Sort.MOST_RELEVANT`)

### Countries Per Run

The `max_countries_per_run` field caps how many storefront countries the plugin iterates through per Lambda invocation. This controls the tradeoff between global coverage and Lambda execution time.

- iOS default: 40 countries (~50 reviews each = ~2000 candidates before dedup)
- Android default: 20 countries (Play Store reviews are more globally pooled)

### Credentials Storage

Credentials are stored in AWS Secrets Manager with keys namespaced by source plugin ID (e.g., `app_reviews_ios_app_name`, `app_reviews_android_package_name`). This prevents plugins from overwriting each other's values. The `BaseIngestor._load_secrets()` method automatically strips the prefix when loading.

## How Global Collection Works

### Strategy

For the configured app, the plugin:

1. Loads the list of supported storefront country codes from `countries.py`
2. Shuffles the country list (so we don't always stall on the same countries if time runs out)
3. Limits to `max_countries_per_run` countries
4. Iterates through countries, fetching the most recent reviews from each
5. Merges all reviews across countries into a single dict keyed by composite ID
6. Deduplicates by stable review ID (same review in multiple storefronts gets one entry)
7. Sorts by date descending
8. Keeps only the top N reviews based on `max_reviews_per_run`
9. Filters out reviews older than the watermark
10. Yields each review to the base ingestor pipeline

### iOS Collection

The iOS plugin uses `app-store-web-scraper` which wraps Apple's undocumented iTunes RSS endpoint:

```
https://itunes.apple.com/{country}/rss/customerreviews/page={page}/id={app_id}/sortby=mostrecent/json
```

- Returns up to 50 reviews per page, max 10 pages = 500 reviews per country
- Built-in session with connection pooling, rate-limit delays (500ms + 200ms jitter), and retry backoff (3 retries, factor 2, max 10s)
- No authentication required
- Sorted by most recent by default
- Returns structured `AppReview` objects with `id`, `date`, `rating`, `title`, `review`, `developer_response`
- Best effort: if a country 404s or times out, it's skipped with a warning log

```python
from app_store_web_scraper import AppStoreEntry, AppStoreSession

session = AppStoreSession(
    delay=0.5,
    delay_jitter=0.2,
    retries=3,
    retries_backoff_factor=2,
    retries_backoff_max=10,
)

app = AppStoreEntry(app_id=123456789, country="ch", session=session)

for review in app.reviews(limit=50):
    print(review.id, review.date, review.rating, review.title, review.review)
```

### Android Collection

The Android plugin uses `google-play-scraper`:

```python
from google_play_scraper import Sort, reviews

result, continuation_token = reviews(
    "com.example.air",
    lang="en",
    country="ch",
    sort=Sort.NEWEST,
    count=100,
)
```

- Fetches 100 reviews per country per request
- Supports `Sort.NEWEST` and `Sort.MOST_RELEVANT`
- Country and language parameters filter by storefront
- No authentication required
- Returns `reviewId`, `content`, `score`, `at`, `userName`, `replyContent`, `repliedAt`, `appVersion`, `thumbsUpCount`

### Deduplication

Each review gets a stable composite ID:

- iOS: `ios_{app_id}_{review_id}` (Apple provides a unique review ID in the RSS feed)
- Android: `android_{package_name}_{review_id}` (Google provides a unique review ID)

The same review appearing in multiple country storefronts gets the same ID and is deduplicated during the merge step.

## Watermark Strategy

Each plugin uses the existing `BaseIngestor` watermark mechanism with keys scoped per app:

| Watermark Key | Value | Purpose |
|---------------|-------|---------|
| `{app_name}_last_published_at` | ISO 8601 timestamp | Newest review timestamp from last successful run |
| `{app_name}_last_run` | ISO 8601 timestamp | When the last collection ran |
| `{app_name}_last_count` | integer (as text) | Reviews fetched from every storefront last run (before the watermark filter); a drop to 0 is warned |

### Incremental Logic

1. On a scheduled run, check `{app_name}_last_run` against the app's `frequency_minutes` (the app
   connector's own value, else the plugin's top-level one; `0` = manual runs only) — skip if not due yet
2. Load the watermark `{app_name}_last_published_at`
3. Collect and deduplicate reviews across countries (each storefront's outcome is tallied — see Error Handling)
4. Compare the candidate count with `{app_name}_last_count`, warn on a drop to 0, store the new count
5. Skip reviews with date ≤ watermark
6. Yield remaining reviews to the pipeline
7. Update watermark to the newest review date from this run
8. Update `{app_name}_last_run` to current time

### Long runs continue in parts (5.47.00)

One iOS app walks ~40 storefronts (90–110 s), so a run over ten apps (a "Run all" on the Data
sources page, or a scheduled tick where many apps are due) used to pass the ingestor's 15-minute
Lambda timeout (Android: 10 minutes) and leave the run row at `running`. A run now checks its
remaining time before each app (`plugins/_shared/app_reviews_parts.py`). When less than the reserve
is left (at least 240 s, or 1.5× the slowest app of this invocation), it stops, sends what it
collected, and starts a new invocation of its **own** function asynchronously with the apps still to
do and the totals so far. Every invocation (a "part") runs at least one app, so N apps take at most
N parts; ten iOS apps take two.

- **Run row** (`SOURCE_RUN#<plugin>`): unchanged contract. It stays `running` while parts follow
  each other, `items_found` is the running total over every part, `started_at` is the first part's,
  and only the last part writes `completed` with every part's warnings as `errors`. A part that
  raises writes `error` (earlier parts' warnings kept); a part that cannot start the next one
  writes `error` with `<n> apps not run: the next part could not start (<type>)`; a later part
  skipped by an open circuit breaker or given a malformed continuation event writes `error`
  (`RunPartRefused`).
- **Sequential, not one invocation per app**: the stores see the same request rate as before and
  only one invocation writes the run row at a time.
- A **manual** run keeps its `execution_id` in every part (frequency and watermark filters stay
  skipped); a **scheduled** run's parts carry none, so each remaining app still gets its due check.
  A run of a single app (`app_id`) never needs a second part.
- An app whose connector was removed or renamed while the run was going is dropped from later parts.
- **IAM**: each app-review ingestor role may `lambda:InvokeFunction` exactly its own function ARN
  (`SELF_CONTINUING_INGESTORS` in `lib/stacks/ingestion-stack.ts`); no other ingestor gets an invoke
  grant.
- A scheduled chain that runs longer than the 30-minute schedule tick (about 18 iOS apps due at
  once) can overlap the next tick for an app it has not reached yet. That app is then fetched by both
  chains, and the processor deduplicates by review id.

### Tradeoffs

- The iTunes RSS endpoint (iOS) returns max 10 pages × 50 reviews = 500 reviews per country. For most apps this covers recent reviews well. Very high-volume apps in a single country may miss some reviews between runs.
- The Play Store scraper (Android) fetches 100 reviews per country. Deeper fetching is possible but capped by `max_reviews_per_run` and Lambda timeout.
- Watermarks are best-effort. If a review's date is backdated by the store, it may be missed.

## Output Format

Each yielded review follows the VoC pipeline's expected schema.

### iOS Output

```python
{
    "id": "ios_123456789_12345678",
    "channel": "app_review_ios",
    "text": "Great app!\n\nLove the new features",  # title + "\n\n" + body
    "title": "Great app!",
    "rating": 5,
    "created_at": "2026-03-06T14:30:00+00:00",
    "url": "https://apps.apple.com/app/id123456789",
    "author": "HappyUser123",
    "brand_handles_matched": ["VoC Analytics"],
    "source_platform_override": "example_air_ios",  # {app_name}_ios
    "app_name": "example_air",
    "app_identifier": "123456789",
    "country": "us",
    "developer_response": "Thanks for the feedback!",
}
```

### Android Output

```python
{
    "id": "android_com.example.air_abc123",
    "channel": "app_review_android",
    "text": "Love the new features",
    "title": "",
    "rating": 5,
    "created_at": "2026-03-06T14:30:00+00:00",
    "url": "https://play.google.com/store/apps/details?id=com.example.air",
    "author": "HappyUser123",
    "brand_handles_matched": ["VoC Analytics"],
    "source_platform_override": "example_air_android",  # {app_name}_android
    "app_name": "example_air",
    "app_identifier": "com.example.air",
    "country": "us",
    "app_version": "24.3.1",
    "developer_response": "Thanks!",
    "developer_response_date": "2026-03-07T10:00:00+00:00",
    "thumbs_up_count": 3,
}
```

The `source_platform_override` field causes `BaseIngestor.normalize_item()` to use the app-specific name for S3 partitioning instead of the generic plugin ID.

## Supported Countries

### iOS Storefronts (40 countries)

US, GB, DE, FR, JP, AU, CA, IT, ES, NL, BR, MX, IN, KR, SE, NO, DK, FI, CH, AT, BE, PT, PL, CZ, RU, TR, SA, AE, ZA, SG, HK, TW, TH, MY, PH, ID, VN, CO, CL, AR

### Play Store Countries (20 countries)

US, GB, DE, FR, JP, AU, CA, IT, ES, NL, BR, MX, IN, KR, SE, RU, TR, SA, ZA, SG

### Overriding Countries

Set `max_countries_per_run` in the plugin card on the Scrapers page to limit iteration. Countries are shuffled each run for fair coverage over time.

## Error Handling

- One country failing does not stop other countries (warning logged, empty list returned)
- All errors are logged with structured context (app name, country, error type)
- **Every app's storefronts are summarised** after each collection, so a failure is visible in
  Administration → System → Logs without AWS access:
  - INFO `iOS <app> (<id>): <n> storefronts with reviews, <n> empty, <n> failed, <n> reviews`
    (structured `storefront_summary`: `app`, `app_identifier`, `storefronts_with_reviews`,
    `storefronts_empty`, `storefronts_failed`, `reviews`);
  - WARNING `... <failed> of <total> storefronts failed - HTTP 403 x12 (gb, us, ...); MaxRetryError(ConnectTimeoutError) x1 (kr)`
    when any storefront failed. A storefront has **failed** when it returned no reviews AND its first
    page answered an error (iOS `AppStoreError`, i.e. an HTTP status) or a connection error ended it
    (urllib3, after the session's retries); an empty storefront is not a failure. Android counts its one
    locale (`<lang>-<country>`) the same way. Causes are an HTTP status or an exception type, never a URL;
  - WARNING `<platform> <app>: no reviews from any storefront (the previous run fetched N)` when an app
    that had reviews last run (watermark `{app_name}_last_count`) gets none now — typically the store is
    blocking or failing requests, or the app id changed.
- A manual run ("Run now") also records those problems in its run row's `errors` (shown on the Data
  sources page), one short line per app: `<app>: 3 storefronts failed (HTTP 403 x3)`,
  `<app>: no reviews from any storefront (previous run: 40)`, `<app>: collection failed (<ExceptionType>)`.
  The run still completes. A scheduled run has no run row; the WARNING lines are its record.
- The platform circuit breaker (`_shared/circuit_breaker.py`) auto-disables the plugin after repeated failures
- Audit events are emitted at each lifecycle stage via `_shared/audit.py` (`plugin.invoked`, `plugin.completed`, `plugin.failed`, `message.ingested`)
- Metrics are emitted per app: `iOS_{app_name}_Reviews`, `Android_{app_name}_Reviews`, and `*_Errors` on failure

## Dependencies

### iOS: `app-store-web-scraper`

- Actively maintained (last release Jun 2024)
- Built-in session management with connection pooling via `urllib3.PoolManager`
- Configurable rate-limit delays with jitter to avoid Apple throttling
- Retry logic with exponential backoff
- Returns structured `AppReview` objects
- Uses Apple's undocumented iTunes RSS endpoint

### Android: `google-play-scraper`

- Standard Python library for Play Store data
- Zero external dependencies
- Supports `Sort.NEWEST` and `Sort.MOST_RELEVANT`
- Country and language parameters for storefront filtering

### Lambda Layer Requirements

Both packages are in the ingestion Lambda layer (`lambda/layers/ingestion-deps/requirements.txt`):

```
app-store-web-scraper>=0.3.0
google-play-scraper>=1.2.7
```

Neither package requires native C extensions, so they work on ARM64 (Graviton) without Docker-based builds.

## Setup & Deployment

1. Both plugins are enabled in `pluginStatus` in `voc-datalake/cdk.context.json`:

```json
{
  "pluginStatus": {
    "webscraper": true,
    "app_reviews_ios": true,
    "app_reviews_android": true
  }
}
```

2. Deploy:

```bash
npm run generate:config
cdk deploy --all
```

3. On the **Scrapers** page, open each plugin card and add one or more apps (App Name, Package Name / App Store ID)

4. Enable the schedule via the toggle in the plugin card

## Assumptions & Limitations

- **Multiple apps per plugin**: each plugin supports several app configurations, managed from the **Configured Apps** list on the Scrapers page and persisted as a JSON array via the `/integrations/{source}/apps` CRUD endpoints.
- **Implementation prerequisite**: none for validation: `source_platform` is checked by pattern in `lambda/shared/ingest_schemas.py`, so no per-plugin source list is needed. Secret filtering no longer needs a per-plugin list either: `_shared/plugin_secrets.py` returns only the plugin's own `<plugin_id>_*` namespace and raises a configuration error when that namespace is empty, so the `_get_known_prefixes()` list this bullet used to also require is gone (issue #251).
- **Unofficial APIs**: Both plugins use unofficial/public endpoints. These can change without notice. The circuit breaker will auto-disable the plugin if endpoints break.
- **Rate limiting**: Apple and Google may rate-limit aggressive scraping. `app-store-web-scraper` has built-in delays with jitter. For Google, the country shuffle and configurable `max_countries_per_run` help manage request volume.
- **iOS review depth**: Max 500 reviews per country (10 pages × 50). High-volume apps may miss reviews between runs if the schedule is too infrequent.
- **No authentication**: Neither source requires API keys. The plugins use public endpoints only.
- **Review language**: Reviews are returned in their original language. The VoC processing pipeline handles translation via Amazon Translate.
- **Developer responses**: Available in both sources but may not always be present. Included when available.
