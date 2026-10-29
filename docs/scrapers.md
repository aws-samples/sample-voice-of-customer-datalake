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

### With the AI assistant (administrators)

On the Scrapers page the assistant can set up connectors for you, and you stay in control: it proposes, an
approval card shows exactly what will be saved, and nothing happens until you approve. These tools are for
administrators only (the routes behind them are admin-only); for anyone else they are not offered, and a call is
refused before any card appears.

| Tool | Kind | What it does |
|---|---|---|
| `list_scrapers` | read | The configured scrapers (administrators also see selectors, pagination and labels). The assistant reads it first, so a new id is unused. |
| `analyze_scraper_url` | read | Calls `POST /scrapers/analyze-url` to suggest CSS selectors for a public https page, then polls `GET /scrapers/jobs/{job_id}` until the suggestion is ready. Only the model sees the suggestion. Nothing is saved. |
| `create_scraper` | write | A new web scraper, saved with `POST /scrapers`. It is saved disabled with no schedule unless you asked for one. A create never overwrites: an existing id is refused before the card, and again right before saving. |
| `update_scraper` | write | Changes fields of an existing scraper. The card reads the stored scraper and shows a before → after diff, with unchanged fields collapsed. Approving saves that merge. If the scraper changed since the card was shown, the save is refused. |
| `create_app_connector` | write | Adds an iOS (`app_reviews_ios`, App Store id) or Android (`app_reviews_android`, package name) app, or a public review page (`web_reviews`, https `url`, `max_pages` 0-100, default 10, 0 = every page; `max_reviews` 0-5000, default 0 = no limit; [web-reviews.md](web-reviews.md)), with `POST /integrations/{source}/apps`. Defaults: 500 reviews per run (apps), manual runs only. An app or page that is already configured (same name or identifier) is refused. |
| `run_scraper` | write | Starts a run. This is a separate step with its own approval, offered after a create. |

The card is deterministic and contains no text written by the model. It has a fixed table of every field that will
be saved: id, name, the URLs (one per line, host in bold), method, each selector, pagination, schedule ("Off" or
"Every N minutes"), enabled, dimension defaults and tags. It ends with "Nothing is saved until you approve" and
Approve / Decline. After the save, the card shows the result with a link to the scraper (`/scrapers#scraper-<id>`),
and the Scrapers list refreshes.

Argument bounds match `_scraper_shape_error` (id pattern, ≤ 25 URLs of ≤ 2,048 characters, text fields ≤ 500,
pagination ≤ 50 pages from ≤ 10,000, schedule 0–43,200 minutes, ≤ 8 KiB per config). The stream Lambda and the SPA
both check them. URLs must also be https, with a public host name: no IP literal, no localhost and no credentials.
The route still applies `shared/url_policy` with DNS resolution. The bounds are pinned on both sides and against
`scrapers_handler.py` and the app-review manifests by
`frontend/src/assistant/approvals/scraperSchemas.lockstep.test.ts`.

These tools are not on the global MCP server (`/mcp/global`). Offering connector writes there would need its own
decision.

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
| POST | `/scrapers` | Admin | Create/update scraper (bounded, see below) |
| DELETE | `/scrapers/{id}` | Admin | Delete scraper |
| GET | `/scrapers/templates` | Any user | Get available templates |
| GET | `/scrapers/connectors` | Any user | App connectors and Web Reviews pages with their `radar_brand`, selected fields only (the AI assistant's `list_scrapers` reads it; docs/radar.md) |
| POST | `/scrapers/{id}/run` | Admin | Trigger manual run |
| GET | `/scrapers/{id}/status` | Any user | Get latest run status |
| POST | `/scrapers/analyze-url` | Admin | AI-assisted selector detection. Answers `202 {success, job_id, status: 'pending'}`; the work runs on `voc-scrapers-assist` |
| GET | `/scrapers/jobs/{job_id}` | The starter | Poll an analyze-url job: `pending` / `running`, then `completed` with `result` or `failed` with `error` |

The same URL prefix also serves the import routes, from a second Lambda
(`manual_import_handler.py`). Every one is **admin-only** (owner decision
2026-10-08, #242 follow-up), enforced by one middleware for the whole module:

| Method | Endpoint | Who | Description |
|--------|----------|-----|-------------|
| POST | `/scrapers/manual/parse` | Admin | Start an LLM parse of pasted review text |
| GET | `/scrapers/manual/parse/{job_id}` | Admin | Poll a parse job |
| POST | `/scrapers/manual/confirm` | Admin | Import the parsed reviews |
| POST | `/scrapers/manual/csv-upload` | Admin | Import CSV rows (column mapping, source profile); with `dataset_name`, `dry_run` previews and `apply_updates` confirms in-place updates of a corrected re-upload ([csv-import.md](csv-import.md)) |
| POST | `/scrapers/manual/json-upload` | Admin | Import JSON items |
| GET | `/scrapers/manual/history` | Admin | Import runs of the last 90 days, newest first (`?limit=`, `?cursor=`); see [import-history.md](import-history.md) |
| GET | `/scrapers/manual/history/{run_id}` | Admin | One import run with its warnings and errors |

Every paste confirm, CSV upload, JSON upload (including the AI assistant's `import_reviews`) and S3
import file writes one run record; the **Import history** section of the Data sources page lists them
([import-history.md](import-history.md)).

S3 bulk import (`/s3-import/*`, `s3_import_handler.py`) is admin-only on every
route for the same reason — see `docs/data-lake-structure.md`.

### Who can do what

Only admins can create, edit, analyze (Auto-detect), run or delete a scraper
(owner decision, 2026-10-08; it reverses the 2026-10-04 decision that let every
user create and edit one). A save rewrites the shared API-credentials secret, and
a saved scraper drives scheduled third-party fetches plus Bedrock enrichment;
analyze-url fetches a URL and spends a Bedrock call. Non-admins get `403` before
any secret read, URL fetch or model call. MCP tokens and agents are never admin,
whoever minted or owns them.

Every signed-in user can still read: the scraper list, templates, run status and
run history. In the UI a non-admin sees scrapers read-only: the editor opens with
every field disabled and a notice, **Save**, **Auto-detect**, **Run Now** and
**Delete** are disabled with the admin-only tooltip, and the web scraper templates
under **New Source** are disabled. Importing data is admin-only too (owner
decision 2026-10-08, #242 follow-up): it writes feedback content straight into
the enrichment pipeline, so a non-admin gets `403` from every import route before
any S3, DynamoDB, SQS or model call, and in the UI the **Manual Import** (paste),
**JSON Upload**, **CSV Upload** and **S3 Bulk Import** tiles are disabled with the
admin-only tooltip and a note; the S3 source's **File Explorer** shows a notice
instead. App-review sources and synthetic data stay available to everyone.
Feedback already imported is unaffected.

An admin's `enabled` and `frequency_minutes` are stored as sent. Scrapers a
non-admin created before this change stay as they are; an admin can edit or
delete them.

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

`POST /scrapers/analyze-url` is admin-only (owner decision, 2026-10-08). The
URL policy still applies to every admin call.

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
