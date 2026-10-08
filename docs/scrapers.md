# Scrapers

The Scrapers feature allows you to collect customer feedback from web pages using configurable extraction rules.

## Overview

Scrapers provide a way to:

- Extract reviews and feedback from web pages
- Use CSS selectors or JSON-LD structured data
- Schedule automatic data collection
- Auto-detect extraction patterns using AI

## Creating a Scraper

### Via the Dashboard

1. Navigate to **Scrapers** in the sidebar
2. Click **New Source**
3. Choose a web scraper template — **Review JSON-LD** or **Custom (CSS Selectors)** — or an app-review source
4. Configure the extraction rules (use **Auto-detect** to let AI suggest CSS selectors)
5. Save, then **Run now** to test

### Scraper Configuration

Web scraper configurations are stored as an array under the `webscraper_configs` key in Secrets Manager. Each entry has this shape:

```json
{
  "id": "unique_scraper_id",
  "name": "My Scraper",
  "base_url": "https://example.com/reviews",
  "urls": [],
  "frequency_minutes": 1440,
  "extraction_method": "css",
  "container_selector": ".review-item",
  "text_selector": ".review-text",
  "rating_selector": ".star-rating",
  "author_selector": ".reviewer-name",
  "date_selector": ".review-date",
  "pagination": {
    "enabled": true,
    "param": "page",
    "max_pages": 10,
    "start": 1
  }
}
```

- `base_url` is the main page to scrape; `urls` is an optional list of additional pages scraped alongside it (one per line in the editor).
- `frequency_minutes` sets the schedule; `0` means **manual only** (run on demand from the dashboard).

## Extraction Methods

### CSS Selectors

Use CSS selectors to target specific elements:

| Selector | Description |
|----------|-------------|
| `container_selector` | Parent element containing each review |
| `text_selector` | Element with the review text |
| `rating_selector` | Element with the rating value |
| `author_selector` | Element with the author name |
| `date_selector` | Element with the review date |

### JSON-LD Structured Data

Many sites include structured data in JSON-LD format. The scraper can automatically extract reviews from this data:

```json
{
  "extraction_method": "jsonld",
  "template": "review_jsonld"
}
```

## Templates

Pre-configured templates for common patterns:

| Template | Description |
|----------|-------------|
| `review_jsonld` | Extract from JSON-LD structured data |
| `custom_css` | Custom CSS selector configuration |

## AI-Assisted Configuration

The **Analyze URL** feature uses AI to automatically detect CSS selectors:

1. Enter the URL you want to scrape
2. Click **Analyze**
3. The system fetches the page and uses an LLM to identify review patterns
4. Review and adjust the suggested selectors

## Pagination

Configure pagination to collect reviews across multiple pages:

```json
{
  "pagination": {
    "enabled": true,
    "param": "page",
    "max_pages": 10,
    "start": 1
  }
}
```

This appends `?page=1`, `?page=2`, etc. to the URL.

## Running Scrapers

### Manual Run

Click **Run Now** on any scraper to trigger immediate execution (admins only). The card shows live run status — **Running…** with the running count of pages scraped and reviews found, then **Completed** when done.

> **Note:** immediately after saving a brand-new scraper, the first **Run Now** can occasionally report "No scraper configuration found" if a warm ingestor Lambda is holding a cached secret. Wait ~30s and run again.

### Scheduled Runs

Scrapers run automatically based on the webscraper plugin schedule (configured in the plugin manifest).

## Run History

View the history of scraper runs including:

- **Status**: Running, completed, or failed
- **Pages scraped**: Number of pages processed
- **Items found**: Number of reviews extracted
- **Errors**: Any issues encountered

## API Endpoints

All routes require a signed-in (Cognito) user. "Admin" means the `admins` group.

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| GET | `/scrapers` | Any user | List all scrapers |
| POST | `/scrapers` | Any user | Create/update scraper (bounded, see below) |
| DELETE | `/scrapers/{id}` | Admin | Delete scraper |
| GET | `/scrapers/templates` | Any user | Get available templates |
| POST | `/scrapers/{id}/run` | Admin | Trigger manual run |
| GET | `/scrapers/{id}/status` | Any user | Get latest run status |
| GET | `/scrapers/{id}/runs` | Any user | Get run history |
| POST | `/scrapers/analyze-url` | Any user | AI-assisted selector detection |

### Who can do what

Any signed-in user can create a scraper and edit any scraper (owner decision).
Only admins can delete a scraper, run one manually, or change its schedule.
In the UI, **Run Now**, **Delete** and the editor's **Frequency** control are
disabled for non-admins and show the admin-only tooltip.

**Schedule fields are admin-only.** `enabled` and `frequency_minutes` decide when
the scheduled ingestor fetches a scraper, so the server ignores a non-admin's
values for them. A non-admin's new scraper is saved active and daily
(`enabled: true`, `frequency_minutes: 1440`). A non-admin's edit keeps the stored
values. The response returns the scraper as stored.

**Save limits.** Scraper configs live in the shared API-credentials secret, so
`POST /scrapers` refuses a save with `400` when:

| Limit | Value |
|-------|-------|
| `id` | 1–64 characters: letters, digits, `_`, `-` |
| Scrapers in total (a new one) | 50 |
| Entries in `urls` | 25 |
| Length of one URL | 2,048 characters |
| `name`, `template`, any selector, `rating_attribute` | 500 characters |
| `pagination.max_pages` | 1–50 |
| `pagination.start` | 0–10,000 |
| `frequency_minutes` | 0–43,200 (30 days) |
| One scraper, serialized | 8 KiB |
| All scraper configs, serialized | 48 KiB, leaving room in the 64 KiB secret for integration credentials |

The limits apply to admins too. An edit that does not grow an already-oversized
set of configs is still allowed, so it can be repaired.

## Processing Pipeline

Scraped data follows the standard processing pipeline:

1. **Extraction** → Scraper fetches and parses web pages
2. **Normalization** → Data converted to standard format
3. **Queue** → Sent to SQS processing queue
4. **Enrichment** → LLM analysis adds insights
5. **Storage** → Saved to DynamoDB and S3

## Deduplication

The system uses deterministic IDs to prevent duplicate entries:

- If the source provides an ID, it's used directly
- Otherwise, a hash is generated from: `created_at + text_hash + url`

This ensures the same review scraped on different days is deduplicated.

## Security

Scrapers fetch URLs that users configure, so every outbound fetch is checked
against one URL policy, `voc-datalake/lambda/shared/url_policy.py` (issue #244).
It ships in both the API Lambda bundle and the webscraper plugin bundle.

**The policy.** A URL is refused unless:

- its scheme is `http` or `https`;
- it carries no userinfo (`user:pass@` or `public.example@10.0.0.1`);
- it has a hostname that is not a localhost alias;
- **every** address the hostname resolves to is public unicast. Refused:
  private (RFC 1918), loopback, link-local (`169.254.0.0/16`, which includes the
  instance metadata endpoint `169.254.169.254`, and `fe80::/10`), IPv6 ULA
  (`fc00::/7`), shared/CGNAT, multicast, reserved, unspecified, and IPv4-mapped
  IPv6 forms of any of these (`::ffff:127.0.0.1`). If one record out of several
  is private, the whole name is refused.

Numeric tricks such as `http://2130706433/`, `http://0x7f000001/` or `http://127.1/`
need no string matching. The resolver turns them into the address they stand for,
and that address is what gets checked.

**Where it is enforced.**

| Path | Check |
|------|-------|
| `POST /scrapers/analyze-url` | Checks the input URL and every redirect hop. The socket is also pinned to the vetted IP at connect time. |
| `POST /scrapers` (save) | Checks `base_url` and every entry of `urls`. Any failure returns `400` with a message naming the URL that failed. |
| Webscraper ingestor (scheduled and manual runs) | Checks every URL before each request. Redirects are never followed by the HTTP library (`allow_redirects=False`). They are followed manually for at most 5 hops, and each `Location` is re-checked before it is requested. |

A URL the ingestor refuses, including a refused redirect hop, fails only that
URL. The refusal is logged and recorded in the run's **Errors**, and the rest of
the run continues. Configs saved before this check existed are covered too,
because the ingestor re-checks at fetch time.

`POST /scrapers/analyze-url` is deliberately open to every authenticated user
(owner decision). It persists nothing, and the URL policy is what protects it.

Both paths pin the connection: the socket connects only to an address the policy
vetted at connect time, so a DNS answer that changes between the check and the
connect (rebinding) cannot reach a private address. The ingestor also ignores
proxy environment variables and `.netrc`, and refuses `https` → `http` redirects.

## Best Practices

1. **Respect rate limits**: Don't scrape too frequently
2. **Check robots.txt**: Ensure scraping is allowed
3. **Use specific selectors**: More specific = more reliable
4. **Test before scheduling**: Verify extraction works correctly
5. **Monitor run history**: Check for errors and adjust as needed
