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
- A configuration that was truncated is also **moved to the back of the queue** for the
  next invocation. Being due and being able to run are different things: a configuration
  whose watermark is held is due every time, the run budget stops the loop, and in stored
  order it was reached first every time — so one site that cannot finish inside the budget
  silently stopped every other scraper in the account from running at all (measured: two
  healthy configurations behind a slow one were never fetched across 20 scheduled
  invocations). Ordering by the recorded truncation keeps both guarantees: the slow
  configuration is still retried immediately, and the ones behind it get the budget first.
  Configurations that have never truncated keep their stored order, and the record is
  cleared as soon as a configuration completes all of its URLs, so a site that was slow
  once is not demoted for ever. The configuration moved back is the one that **spent** the
  budget, which is not always the one the shortage is noticed on: a configuration that
  consumes the whole budget while still finishing its own URL list leaves the next one to
  discover it, and that one has requested nothing. It is therefore reported as neither run
  nor truncated — no run row, no watermark — so it simply stays due, rather than being
  blamed for a budget another configuration spent and demoted in its place. A
  `ScraperRunBudgetExhausted` metric is emitted so an account that truncates on every
  schedule can be alerted on — a scheduled run writes no run row, so otherwise only the
  logs would show it.
- A stored configuration array holding nothing usable reports an `error` run rather than
  finishing silently, so a manually triggered run cannot be left at `running` with nothing
  to reconcile it. An unusable entry alongside working ones is dropped and logged, and the
  working ones still run.
- Exceeding the five-hop redirect bound is reported as a **transport** failure rather
  than a blocked destination — every hop in such a chain was cleared, so treating it as
  a refusal raised a security alert for a site that was simply long-winded. The page is
  skipped with a warning like any other fetch failure, and the preview route still
  answers 400 naming the limit. Note that five is lower than the HTTP client's own
  default of 30, because each hop here costs a fresh resolve-and-check: a public site
  needing more hops is refused where it previously succeeded.
- One unreadable configuration costs that configuration, not the whole invocation.
  A missing `id`, a `pagination.max_pages` of `"10"`, a `pagination` that is not an
  object, or an unparseable stored `last_run`/`frequency_minutes` used to stop the
  scraping loop outright — so **no** configuration in the account ingested, and a
  manually triggered run was again left at `running`. It is handled at three points:
  the write routes refuse those shapes with a 400 naming the field; the scheduled
  scraper coerces values already stored, using the same defaults an absent value
  gets and treating an unreadable schedule as *due* (never running again is the worse
  failure); and the configuration loop catches anything else, logs at ERROR, emits a
  `ScraperConfigUnusable` metric, writes a terminal `error` status and moves on to the
  next configuration. An unusable configuration is not marked as having run, so
  correcting it does not mean waiting out its frequency first.

  That blame stops at the run's own status write. A failure *after* it — a rejected
  metric name, a throttled status update — leaves the recorded status alone and emits
  `ScraperReportingFailed` instead of `ScraperConfigUnusable`, because it previously
  appended a second, contradictory `error` row over a run whose items had already been
  queued and made the unusable-configuration alarm fire for healthy runs.
- `pagination` is checked for **shape** on write even though it names no destination
  (its URLs are built from `base_url`, so they carry a host already checked, and each
  is re-checked before its request in any case). `max_pages` and `start` must be
  integers, and `max_pages` must be between **1 and 50** — the bounds the editor
  already applies. This is also what bounds how many URLs one configuration can cause
  to be fetched, which the 50-URL cap does not: that cap counts the URLs a
  configuration *names*, and pagination multiplies them. The scheduled scraper
  **clamps** a stored value to the same bounds rather than only coercing its type,
  because a value saved before the bound existed is exactly what it is there for: a
  stored `max_pages` of `"100000"` built 100 000 URLs, and larger values exhausted the
  function's memory before it made a single request — which loses the terminal status
  write and strands a manually triggered run at `running`.
- `id` is **required** on write, and must be a non-empty string of at most 128
  characters. It names no destination either, but the scraper computes with it: it is
  the prefix of every extracted item's id, so a configuration without one fetched all
  of its pages and then dropped every item while reporting `completed` with no errors
  — indistinguishable from a site that simply had nothing new. It is also the schedule
  watermark key and the metric name, so two configurations sharing an id share a
  schedule, and an over-long one exceeds the metrics service's 255-character name
  limit.

  The requirement applies to an id a write **creates or changes**, not to one it
  carries forward — the same carry-forward exemption the 50-URL cap has. The Settings
  card saves the whole array, so applying it retroactively made one configuration
  stored without an id block every later save, including a rename of an unrelated
  one, with no way to repair the offender (an edit is keyed on the id). A
  configuration the write *adds* is still refused. `DELETE /scrapers/<id>` also now
  matches a stored non-string id, which it previously could not: one stored as the
  number `7` was never matched and the delete removed nothing.

  For configurations **already stored** the scheduled scraper is deliberately more
  tolerant, because only a *missing* id ever lost data. A numeric, empty or over-long
  id each prefixed its items and ingested normally — the prefix is an interpolation,
  so it accepts any value — and refusing those would have stopped ingestion on deploy
  for an existing account. A numeric id is coerced to the string its items already
  used, an empty or over-long one keeps ingesting (the metric name is truncated
  instead, since its length never prevented the scraping), and only an id that cannot
  be one at all — missing, or a boolean/list/object, which no client produces — is
  reported as an error rather than scraped into a silent drop.
- An unreadable **schedule** is treated as *due* rather than raising, including a
  `frequency_minutes` that is not a finite, non-negative number. `NaN` and `Infinity`
  are valid JSON, and computing a next-run time from either raised — which the
  per-configuration guard turned into that configuration being skipped on every
  invocation, for ever. Of the two directions, running more often than intended is
  recoverable and never running again is not.
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
