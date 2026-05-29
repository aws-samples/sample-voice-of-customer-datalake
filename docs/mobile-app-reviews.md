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

## Settings Page UI

Both plugins appear as cards in **Settings → Data Sources & Integrations**, rendered dynamically from their manifests. Each card configures a single app.

### iOS Plugin Settings

The iOS plugin card shows these config fields:

| Field | Key | Type | Default | Description |
|-------|-----|------|---------|-------------|
| App Name | `app_name` | text | — | Logical app name (required) |
| App Store ID | `app_id` | text | — | Apple App Store numeric ID (required) |
| Review Sort Order | `sort_by` | select | `most_recent` | `most_recent` or `most_critical` |
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

Both plugins offer the same frequency options via a select dropdown:

| Value | Label |
|-------|-------|
| `15` | Every 15 minutes |
| `30` | Every 30 minutes |
| `60` | Every hour |
| `180` | Every 3 hours |
| `360` | Every 6 hours |
| `720` | Every 12 hours |
| `1440` | Daily |

### Sort Order

**iOS options:**
- `most_recent` — Fetch newest reviews first (default, recommended)
- `most_critical` — Fetch lowest-rated reviews first

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

app = AppStoreEntry(app_id=585629514, country="ch", session=session)

for review in app.reviews(limit=50):
    print(review.id, review.date, review.rating, review.title, review.review)
```

### Android Collection

The Android plugin uses `google-play-scraper`:

```python
from google_play_scraper import Sort, reviews

result, continuation_token = reviews(
    "de.zalando.mobile",
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

### Incremental Logic

1. On each run, check `{app_name}_last_run` against `frequency_minutes` — skip if not due yet
2. Load the watermark `{app_name}_last_published_at`
3. Collect and deduplicate reviews across countries
4. Skip reviews with date ≤ watermark
5. Yield remaining reviews to the pipeline
6. Update watermark to the newest review date from this run
7. Update `{app_name}_last_run` to current time

### Tradeoffs

- The iTunes RSS endpoint (iOS) returns max 10 pages × 50 reviews = 500 reviews per country. For most apps this covers recent reviews well. Very high-volume apps in a single country may miss some reviews between runs.
- The Play Store scraper (Android) fetches 100 reviews per country. Deeper fetching is possible but capped by `max_reviews_per_run` and Lambda timeout.
- Watermarks are best-effort. If a review's date is backdated by the store, it may be missed.

## Output Format

Each yielded review follows the VoC pipeline's expected schema.

### iOS Output

```python
{
    "id": "ios_585629514_12345678",
    "channel": "app_review_ios",
    "text": "Great app!\n\nLove the new features",  # title + "\n\n" + body
    "title": "Great app!",
    "rating": 5,
    "created_at": "2026-03-06T14:30:00+00:00",
    "url": "https://apps.apple.com/app/id585629514",
    "author": "HappyUser123",
    "brand_handles_matched": ["VoC Analytics"],
    "source_platform_override": "zalando_ios",  # {app_name}_ios
    "app_name": "zalando",
    "app_identifier": "585629514",
    "country": "us",
    "developer_response": "Thanks for the feedback!",
}
```

### Android Output

```python
{
    "id": "android_de.zalando.mobile_abc123",
    "channel": "app_review_android",
    "text": "Love the new features",
    "title": "",
    "rating": 5,
    "created_at": "2026-03-06T14:30:00+00:00",
    "url": "https://play.google.com/store/apps/details?id=de.zalando.mobile",
    "author": "HappyUser123",
    "brand_handles_matched": ["VoC Analytics"],
    "source_platform_override": "zalando_android",  # {app_name}_android
    "app_name": "zalando",
    "app_identifier": "de.zalando.mobile",
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

Set `max_countries_per_run` in the Settings UI to limit iteration. Countries are shuffled each run for fair coverage over time.

## Error Handling

- One country failing does not stop other countries (warning logged, empty list returned)
- All errors are logged with structured context (app name, country, error type)
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

3. In the Settings page, expand each plugin card and enter the app details (App Name, Package Name / App Store ID)

4. Enable the schedule via the toggle in the Settings UI

## Assumptions & Limitations

- **Single app per plugin**: Currently each plugin supports one app configuration. Multi-app support (multiple package names / app IDs per plugin) is planned.
- **Implementation prerequisite**: The `KNOWN_SOURCES` set in `_shared/schemas.py` and the `_get_known_prefixes()` list in `_shared/base_ingestor.py` must include `app_reviews_ios` and `app_reviews_android` for proper secret filtering and message validation.
- **Unofficial APIs**: Both plugins use unofficial/public endpoints. These can change without notice. The circuit breaker will auto-disable the plugin if endpoints break.
- **Rate limiting**: Apple and Google may rate-limit aggressive scraping. `app-store-web-scraper` has built-in delays with jitter. For Google, the country shuffle and configurable `max_countries_per_run` help manage request volume.
- **iOS review depth**: Max 500 reviews per country (10 pages × 50). High-volume apps may miss reviews between runs if the schedule is too infrequent.
- **No authentication**: Neither source requires API keys. The plugins use public endpoints only.
- **Review language**: Reviews are returned in their original language. The VoC processing pipeline handles translation via Amazon Translate.
- **Developer responses**: Available in both sources but may not always be present. Included when available.
