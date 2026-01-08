# Default Scraper Templates

This document contains tested and working scraper configurations for common review sites, including field mapping details and extraction rules.

## Table of Contents

1. [Field Mapping Reference](#field-mapping-reference)
2. [Trustpilot (JSON-LD)](#1-trustpilot-json-ld)
3. [Skytrax Airline Quality](#2-skytrax-airline-quality)
4. [ConsumerAffairs](#3-consumeraffairs)
5. [Reddit Thread](#4-reddit-thread)
6. [Sites That Don't Work](#sites-that-dont-work-bot-detection)
7. [Creating Custom Scrapers](#creating-custom-scrapers)

---

## Field Mapping Reference

### JSON-LD Extraction (Trustpilot, etc.)

When using `extraction_method: "jsonld"`, we extract from Schema.org Review structured data:

| Our Field | JSON-LD Source | Example | Notes |
|-----------|----------------|---------|-------|
| `title` | `headline` | "ABSOLUTELY horrible customer service" | Review headline/title |
| `text` | `reviewBody` | Full review text | Combined with title as "title\n\ntext" |
| `rating` | `reviewRating.ratingValue` | "1" → 1 | Converted to integer (1-5) |
| `author` | `author.name` | "kunde" | Reviewer's display name |
| `url` | `author.url` | `https://trustpilot.com/users/...` | **Link to author profile** |
| `created_at` | `datePublished` | "2025-11-26T01:59:06.000Z" | **Converted to CET timezone** |

#### Raw JSON-LD Example (Trustpilot)

```json
{
  "@type": "Review",
  "author": {
    "@type": "Person",
    "name": "kunde",
    "url": "https://www.trustpilot.com/users/61864270e18e5000122bd65d/"
  },
  "datePublished": "2025-11-26T01:59:06.000Z",
  "headline": "ABSOLUTELY horrible customer service",
  "reviewBody": "ABSOLUTELY horrible customer service. We were late...",
  "reviewRating": {
    "@type": "Rating",
    "bestRating": "5",
    "worstRating": "1",
    "ratingValue": "1"
  },
  "inLanguage": "en"
}
```

#### Extraction Rules

1. **URL**: We use `author.url` as the clickable link (takes user to reviewer's profile)
2. **Date**: Converted from UTC to Central European Time (Europe/Berlin)
3. **Rating**: Extracted from `reviewRating.ratingValue`, converted to integer
4. **Text**: If `headline` exists, combined as `"headline\n\nreviewBody"`

---

### CSS Extraction (Skytrax, ConsumerAffairs, etc.)

When using `extraction_method: "css"`, we use CSS selectors to find elements:

| Our Field | Selector Config | How It Works |
|-----------|-----------------|--------------|
| `title` | `title_selector` | `.get_text(strip=True)` from element |
| `text` | `text_selector` | `.get_text(strip=True)` from element |
| `rating` | `rating_selector` | Tries: data attribute → class pattern → text |
| `author` | `author_selector` | `.get_text(strip=True)` from element |
| `url` | `link_selector` | `href` attribute from first `<a>` in container |
| `created_at` | `date_selector` | `datetime` attribute or text content |

#### Rating Extraction Logic

The scraper tries multiple methods to extract ratings:

1. **Data attribute**: `element[data-rating]` or `element[rating_attribute]`
2. **Class pattern**: Looks for `rating-4`, `stars-5` in class names
3. **Text pattern**: Regex for `4/5`, `4 stars`, `4★`

---

## Deployment

### Via Frontend

1. Go to **Scrapers** page
2. Click **New Scraper**
3. Select a template or create custom
4. Fill in the URL and save

### Via API (curl)

```bash
API_ENDPOINT="https://your-api.execute-api.region.amazonaws.com/v1"

curl -X POST "$API_ENDPOINT/scrapers" \
  -H "Content-Type: application/json" \
  -d '{"scraper": { ...config... }}'
```

---

## Working Templates

### 1. Trustpilot (JSON-LD)

Best method - extracts structured data embedded in the page. Most reliable.

```json
{
  "id": "trustpilot_example",
  "name": "Example - Trustpilot",
  "enabled": true,
  "base_url": "https://www.trustpilot.com/review/example.com",
  "urls": [],
  "frequency_minutes": 0,
  "extraction_method": "jsonld",
  "template": "trustpilot",
  "pagination": {
    "enabled": true,
    "param": "page",
    "start": 1,
    "max_pages": 10
  }
}
```

**URL Pattern:** `https://www.trustpilot.com/review/{company-domain}`

**What Gets Extracted:**

| Field | Source | Example |
|-------|--------|---------|
| Title | `headline` | "Great service!" |
| Text | `reviewBody` | Full review content |
| Rating | `reviewRating.ratingValue` | 5 |
| Author | `author.name` | "John D." |
| Link | `author.url` | Trustpilot profile URL |
| Date | `datePublished` | Converted to CET |

**Examples:**
- `https://www.trustpilot.com/review/lufthansa.com`
- `https://www.trustpilot.com/review/amazon.com`

---

### 2. Skytrax Airline Quality

CSS-based extraction from airlinequality.com.

```json
{
  "id": "skytrax_example",
  "name": "Example - Skytrax",
  "enabled": true,
  "base_url": "https://www.airlinequality.com/airline-reviews/lufthansa/",
  "urls": [],
  "frequency_minutes": 0,
  "extraction_method": "css",
  "container_selector": "article.comp_media-review-rated",
  "text_selector": ".text_content",
  "title_selector": ".text_header",
  "rating_selector": ".rating-10 span",
  "author_selector": ".text_sub_header span",
  "date_selector": "time",
  "pagination": {
    "enabled": true,
    "param": "page",
    "start": 1,
    "max_pages": 10
  }
}
```

**URL Pattern:** `https://www.airlinequality.com/airline-reviews/{airline-slug}/`

**Examples:**
- `https://www.airlinequality.com/airline-reviews/lufthansa/`
- `https://www.airlinequality.com/airline-reviews/british-airways/`

---

### 3. ConsumerAffairs

CSS-based extraction from consumeraffairs.com.

```json
{
  "id": "consumeraffairs_example",
  "name": "Example - ConsumerAffairs",
  "enabled": true,
  "base_url": "https://www.consumeraffairs.com/travel/lufthansa.html",
  "urls": [],
  "frequency_minutes": 0,
  "extraction_method": "css",
  "container_selector": ".js-rvw",
  "text_selector": ".rvw__top-text, .rvw__all-text",
  "rating_selector": "[itemprop=\"ratingValue\"]",
  "author_selector": ".rvw__inf-nm",
  "date_selector": ".rvw__rvd-dt",
  "pagination": {
    "enabled": true,
    "param": "page",
    "start": 1,
    "max_pages": 5
  }
}
```

**URL Pattern:** `https://www.consumeraffairs.com/{category}/{company}.html`

---

### 4. Reddit Thread

CSS-based extraction from old.reddit.com (more reliable than new Reddit).

```json
{
  "id": "reddit_example",
  "name": "Example - Reddit Thread",
  "enabled": true,
  "base_url": "https://old.reddit.com/r/subreddit/comments/thread_id/slug/",
  "urls": [],
  "frequency_minutes": 0,
  "extraction_method": "css",
  "container_selector": ".comment",
  "text_selector": ".md",
  "author_selector": ".author",
  "date_selector": "time",
  "pagination": {
    "enabled": false,
    "param": "page",
    "start": 1,
    "max_pages": 1
  }
}
```

**Note:** Use `old.reddit.com` instead of `www.reddit.com` for reliable scraping.

---

## Sites That Don't Work (Bot Detection)

| Site | Issue | Alternative |
|------|-------|-------------|
| TripAdvisor | 403 Forbidden | Use official API |
| Yelp | Bot detection | Use Yelp Fusion API |
| HelloPeter | SPA (requires JS) | Headless browser |
| ProductReview AU | Next.js SSR | Headless browser |

---

## Creating Custom Scrapers

### CSS Extraction Method

1. Open the target page in browser
2. Right-click on a review → Inspect
3. Find the container element that wraps each review
4. Find selectors for: text, rating, author, date
5. Test selectors in browser console: `document.querySelectorAll('.your-selector')`

### JSON-LD Extraction Method

1. View page source (Ctrl+U)
2. Search for `<script type="application/ld+json">`
3. Look for `@type: "Review"` objects
4. If found, use `extraction_method: "jsonld"`

### Configuration Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (lowercase, underscores) |
| `name` | Yes | Display name |
| `enabled` | Yes | Whether scraper is active |
| `base_url` | Yes | Starting URL to scrape |
| `urls` | No | Additional URLs to scrape |
| `frequency_minutes` | Yes | 0 = manual only |
| `extraction_method` | Yes | `css` or `jsonld` |
| `template` | JSON-LD | Template name (e.g., "trustpilot") |
| `container_selector` | CSS only | Selector for review container |
| `text_selector` | CSS only | Selector for review text |
| `title_selector` | No | Selector for review title |
| `rating_selector` | No | Selector for rating |
| `author_selector` | No | Selector for author name |
| `date_selector` | No | Selector for date |
| `pagination.enabled` | Yes | Enable multi-page scraping |
| `pagination.param` | Yes | URL parameter for page number |
| `pagination.start` | Yes | First page number (usually 1) |
| `pagination.max_pages` | Yes | Maximum pages to scrape |

---

## Output Data Format

Each scraped review produces a record with these fields:

```json
{
  "id": "scraper_trustpilot_example_abc123",
  "channel": "web_scrape_jsonld",
  "url": "https://www.trustpilot.com/users/12345/",
  "text": "Great service!\n\nFull review text here...",
  "title": "Great service!",
  "rating": 5,
  "created_at": "2025-11-26T02:59:06+01:00",
  "author": "John D.",
  "scraper_id": "trustpilot_example",
  "scraper_name": "Example - Trustpilot",
  "domain": "www.trustpilot.com",
  "extraction_method": "jsonld",
  "source_platform_override": "Example - Trustpilot"
}
```

---

## Tested: December 2025

These templates were tested against Lufthansa review pages and confirmed working.
