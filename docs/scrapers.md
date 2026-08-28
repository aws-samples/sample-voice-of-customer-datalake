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

Click **Run Now** on any scraper to trigger immediate execution. The card shows live run status — **Running…** with the running count of pages scraped and reviews found, then **Completed** when done.

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/scrapers` | List all scrapers |
| POST | `/scrapers` | Create/update scraper |
| DELETE | `/scrapers/{id}` | Delete scraper |
| GET | `/scrapers/templates` | Get available templates |
| POST | `/scrapers/{id}/run` | Trigger manual run |
| GET | `/scrapers/{id}/status` | Get latest run status |
| GET | `/scrapers/{id}/runs` | Get run history |
| POST | `/scrapers/analyze-url` | AI-assisted selector detection |

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

One outbound-URL policy, in `voc-datalake/lambda/shared/http_utils.py`, guards every
scraper request against SSRF (Server-Side Request Forgery). It is applied at three
points, not one:

- **On save** — `POST /scrapers`, and `PUT /integrations/webscraper/credentials`
  (the Settings card, which writes the whole configuration array). Both write paths
  refuse a configuration naming a destination the policy will not clear, so an
  internal target cannot be scheduled in the first place.
- **On preview** — `POST /scrapers/analyze-url`, before anything reaches the model.
- **At fetch time** — the scheduled ingestor re-checks each URL immediately before
  requesting it, and again for **every redirect hop**. A host that was public when
  it was saved can start resolving internally afterwards, so a stored approval is
  not treated as a standing one.

What the policy accepts and refuses:

- Only `http` and `https`. URLs carrying embedded credentials, and `localhost`
  aliases, are refused.
- The hostname is **resolved**, and the URL is refused if **any** returned address
  is non-global — loopback, private, link-local (including the instance metadata
  address `169.254.169.254`), multicast, unspecified, reserved or IPv6 site-local,
  in IPv4, IPv6, or IPv4 tunnelled inside IPv6 (v4-mapped, 6to4, Teredo).
- It **fails closed**: a resolver failure, an empty answer, and a mixed
  public/private answer set are all refusals, because the HTTP client — not the
  platform — picks which address in an answer set to connect to.
- Redirects are followed by the platform itself, one hop at a time, never by the
  HTTP client, and are bounded at 5 hops. Credentials — the `Authorization` and
  `Cookie` headers and the `auth=`/`cookies=` request options alike — are dropped on
  exactly the hops the `requests` library drops them on, which the platform asks it
  rather than deciding for itself: a host change, a port change and an
  `https`→`http` downgrade all drop them; a site's own `http`→`https` upgrade does
  not. A `Location` header that resolves back to the URL that sent it ends the walk
  rather than spending the hop budget on one page.
- Each page fetch also carries a wall-clock budget (60 seconds), not only a
  per-request timeout. The scheduled scraper has 300 seconds for a configuration
  that may name 50 URLs, and a retried redirect walk on one stalling host could
  otherwise consume nearly all of it — which loses the run's final status write, not
  just that page. A page that exceeds the budget is skipped with a warning and the
  configuration's remaining URLs still run.
- The **invocation** carries its own budget (240 seconds), because the per-page one
  does not bound their sum: one invocation runs every configuration that is due, each
  with all of its URLs, so ten stalling pages spent 450 seconds against the 300 second
  limit. When the run budget is spent the invocation stops, notes in the run's `errors`
  how many URLs were not attempted, and reports `completed_with_errors` rather than a
  `completed` that would hide the truncation. Every configuration stays due for the next
  run — those not reached were never marked, and the truncated one keeps its watermark
  deliberately, because marking it as having run would leave its unattempted URLs
  starved rather than retried (the URL list rebuilds in the same order, so a
  persistently slow prefix would be re-walked forever). The retry starts from the first
  URL again rather than resuming where it stopped. A page that never loaded no longer
  counts toward the run's page total, so a run in which everything timed out is
  distinguishable from an empty but healthy one.
- A configuration may name at most **50** URLs in `urls`. Each distinct host costs one
  DNS lookup inside the saving request, and both write routes answer through API
  Gateway's 29 second limit; identical hosts within one write are resolved once. The
  limit applies only to a list a write **changes** — a longer list saved before the
  limit existed continues to save untouched, so one such configuration cannot block
  edits to the others stored alongside it, though adding to it is refused.

**Residual risk.** The check resolves the hostname and the HTTP client then resolves
it again when it connects, so a record engineered to answer differently between the
two lookups (DNS rebinding) is narrowed but not closed. Closing it requires pinning
the validated address, which the platform does not do today.

## Best Practices

1. **Respect rate limits**: Don't scrape too frequently
2. **Check robots.txt**: Ensure scraping is allowed
3. **Use specific selectors**: More specific = more reliable
4. **Test before scheduling**: Verify extraction works correctly
5. **Monitor run history**: Check for errors and adjust as needed
