# Web reviews (generic review-page plugin)

The `web_reviews` plugin reads customer reviews from **public review pages**, such as a company page on a review
site, a travel listing or a forum, with a managed browser. It imports them through the normal pipeline (source
policy, raw archive, processing queue). It is site-agnostic: nothing in it knows a particular site. Administrators
add pages; every page becomes its own source.

It is **on by default** (`pluginStatus.web_reviews: true` in `voc-datalake/cdk.context.json`) and does nothing
until an administrator adds a page.

## Adding pages

- **Data sources** (`/scrapers`) → **New source** → **A website link** → **Review page**: add a page with a name,
  its `https` URL, how much to read (pages per run, 0-100, default 10; reviews per run, 0-5,000, default 0; see
  [Reading modes](#reading-modes)) and a run frequency (manual only by default). Each page is listed under
  **Review pages** with Run now, Edit, Delete and the last run's status.
- **AI assistant** (administrators): `create_app_connector` with `source: "web_reviews"`, `url` and optionally
  `max_pages` / `max_reviews`, approved on a card. In plan mode the assistant can find review pages with web search
  (`plan_lookup`), list each chosen URL as its own write on the plan card, then `run_source web_reviews` and wait
  for the run ([assistant-plan-mode.md](assistant-plan-mode.md)).
- **API**: `POST /integrations/web_reviews/apps` with `{"app": {"app_name", "url", "max_pages"?,
  "max_reviews"?, "frequency_minutes"?, "enabled"?}}` (admin). The target is validated before it is saved
  (`lambda/shared/web_review_targets.py`): https only, the host must resolve to public addresses only (the shared
  outbound URL policy / SSRF guard), `max_pages` 0-100, `max_reviews` 0-5000 (both stored as strings),
  `frequency_minutes` one of 0, 15, 30, 60, 180, 360, 720,
  1440; unknown fields are dropped. Targets are stored like the app connectors, as `web_reviews_configs` in the
  shared API-credentials secret, and re-validated on every run.

## Reading modes

`max_pages` 0 means every page (up to the hard cap of 100 pages per target) and `max_reviews` 0 means no review
limit; a target stops at whichever limit it reaches first.

| Mode | `max_pages` | `max_reviews` | Example |
|---|---|---|---|
| The latest N pages | N (1-100) | 0 | `10` / `0`: the newest ten pages |
| The latest N reviews | 0 | N (1-5,000) | `0` / `200`: the newest 200 reviews, however many pages they take |
| Everything | 0 | 0 | every page, up to 100 pages |

A run reads at most 5,000 reviews over all its targets. A target whose read is cut short continues in the next
run (see [Backfill across runs](#backfill-across-runs)).

## How a run works

1. **One browser session per run.** The ingestor starts an Amazon Bedrock AgentCore Browser session on the
   AWS-managed browser `aws.browser.v1` (`StartBrowserSession`), connects to its automation stream (a
   SigV4-signed websocket) and drives it over the Chrome DevTools Protocol. The session timeout ends with the
   Lambda's own time; the session is **always** stopped (`StopBrowserSession`) in a `finally`. The browser
   announces itself honestly: its User-Agent contains `Amazon-Bedrock-AgentCore-Browser`; nothing is spoofed.
2. **Pages.** Page 1 is a real navigation (any JavaScript challenge the site runs is passed once). The next
   page is the page's `<link rel=next>`, an `<a rel=next>`, a link whose text or aria-label is "next" (in a few
   languages, or `›` / `»`), else the URL's `page`/`p`/`pg` parameter plus one. It must keep the target's origin
   (scheme, host and port) and pass the URL policy. A page the browser ends up on another host (a redirect) stops
   the target with `"<target>: redirected off-host"`; nothing from it is imported. JSON-LD is capped at ~1 MB per
   page and a browser reply over 8 MB is refused. Same-origin pages are fetched from inside the tab (`fetch` + `DOMParser`, cookies
   kept), others are navigated to. A navigated page is first scrolled to its bottom (at most six window heights,
   0.6 s apart, stopping when the page stops growing) so reviews that load on scroll are read too. Reading stops
   at the target's page or review limit, at a page with no new review, with no next page, at the run's 5,000
   reviews, or when the run's time budget is spent; the run log names the reason (`stop: pages | reviews |
   no_next | no_new | time | blocked | off_host`).
3. **Extraction.** schema.org JSON-LD `Review` / `UserReview` objects first (top-level arrays, `@graph`, nested
   under a Product's `review`; rating normalised to 1-5 with `bestRating` / `worstRating`; author, date, title,
   body). Without JSON-LD, the page's visible text (at most 160,000 characters) goes to the `enrichment` model
   (Administration → AI models) in chunks of at most 40,000 characters (at most four, cut on line boundaries, each
   repeating about 1,000 characters of the one before), one model call per chunk, each as a delimited data block
   with an instruction never to follow instructions inside it. The model answers JSON Lines, one review per
   line, so a reply cut off at the output cap keeps every complete line; the chunks' reviews are merged and a
   review read twice (same text and date) is kept once. Every review is validated (text 1-5,000 characters,
   rating 1-5 or none, an ISO date or none); lines that fail are dropped. At most 400 reviews per page.
   Text and title are queued as plain text: markdown escapes (`situation\.On`) and `**` markers are removed and an
   escaped full stop that glued two sentences gets its space back (`review_text.py`; the same rules display older
   stored reviews cleanly in the app and the assistant, `schemas/review-text-cleanup-cases.json`; stored data is
   not rewritten).
4. **Items.** `id` = `web_` + sha256(host, text, date): the same review read again gets the same id, so the
   processor deduplicates it. `created_at` is the review's date (else the import time), `url` the page it was
   read on, `channel` the target's name, `author` / `title` when the page has them, `metadata` = the target name
   and page number.
5. **Watermark.** Per target, the newest review date seen; a review older than that date minus one day is not
   sent again (undated reviews always are; their id deduplicates them). It only ever moves forward.
6. **Page cache.** Per page, the sha256 of its JSON-LD and visible text is kept as a watermark
   (`target_<id>_page_<sha256(url)[:16]>`). When a regular (not resuming) run finds a page exactly as it was, the
   page counts as having no new review (no extraction, no model call), and the read stops there as on any page
   without a new review. The check applies to every page alike (a JSON-LD page never costs a model call, so
   there it only saves parsing). The hash is written after the page's reviews were taken, and only when it
   changed: at most one watermark write per page.

## Backfill across runs

When a target's read stops because the run ran out of time or reached its 5,000-review cap, while a next page
exists and the target's own limits are not reached, the plugin stores a cursor (`target_<id>_resume` =
`{"url", "page", "reviews"}`: the page to read next, the pages and reviews read so far). The next run, manual or
scheduled, starts that target at the cursor: it counts pages and reviews from it (so `max_pages` / `max_reviews`
apply to the whole backfill), treats every review as new (these are older pages; the deterministic review id and
the processor's idempotency drop any repeat) and does not stop on a page without a new review. A page cut at the
run's cap is read again from its start. The cursor is cleared when the target finishes for any other reason (a
limit reached, no next page, blocked, redirected off-host, or an error), and it is ignored (and cleared) when the
target's limits were lowered below it. The run log says `resuming at page N` for a resumed target.

## Sources per connector

Every target is its own source, `web_<site>_<app_name>`: the site is the page host's registrable name (`www.`,
`m.` and the country/second-level suffix dropped: `www.ratings.example`, `uk.ratings.example` and
`www.ratings.co.uk` are all `ratings`), the name is the target's `app_name` lower-cased with every other character
run as `_`. So app_name "Example Air" on a www.ratings.example page is `web_ratings_example_air`, and two brands
read from one site do not share a source (an id longer than 48 characters keeps its start plus a short hash).

The label is minted **once**, by `POST /integrations/web_reviews/apps` when the target is created, and stored on
it as `source_id`; a client-supplied `source_id` is ignored, and editing the target (a rename, a new URL) keeps the
stored one, so its reviews never move to a new source. That id is what feedback filters, category/source access
and **source profiles** use, so PII policy, retention and "restricted" are set per connector
([source-policies.md](source-policies.md)). Persona and PR/FAQ generation can be pinned to them with `sources`.

**Upgrade note**: targets saved before `source_id` existed keep working. Their source is minted from the stored
host and name (the same rule) on every run, and stored the next time the target is saved. Reviews they imported
earlier stay under their old `web_<host>` source (e.g. `web_www_…_com`).

## Blocked sites

Some sites refuse automated browsers from cloud addresses. A blocked page is **reported, never read as empty**:
the run completes with an error per target, `"<target>: blocked by <vendor>"`, shown on the card. Detected:
DataDome, HUMAN (PerimeterX, "press & hold"), Cloudflare challenges, AWS WAF challenges, Reddit's network
security page, CAPTCHAs, an HTTP 4xx/5xx main document, and a short "access denied" page.

In testing from AWS, review sites that publish JSON-LD review markup were readable (about 20 reviews per page),
while sites behind DataDome or HUMAN bot protection, or that require a login, were blocked. The plugin does not
use Web Bot Auth signing. Respect each site's terms of use when you add it.

## Cost

Each run starts one browser session and, for pages without JSON-LD, makes one model call per 40,000 characters of
page text (at most four per page); a page unchanged since the last run makes none. See
[Amazon Bedrock AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) for browser session time
and [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) for the model calls.

## Infrastructure and regions

- Lambda `voc-ingestor-web_reviews` (VocIngestionStack, Python 3.14, ARM64, 900 s, 512 MB). Its schedule rule
  (`rate(15 minutes)`) is created **disabled**; each target's `frequency_minutes` decides whether a scheduled
  tick reads it.
- IAM (dedicated role, manifest `infrastructure.ingestor.browser: true`): `bedrock-agentcore:StartBrowserSession`
  and `StopBrowserSession` on `arn:aws:bedrock-agentcore:<region>:aws:browser/aws.browser.v1` only;
  `bedrock-agentcore:ConnectBrowserAutomationStream` on `*`, because the service authorization reference lists
  no resource type for it (the IAM policy simulator denies it on the browser ARN); plus the Bedrock model grant
  of `bedrock: true`.
- Dependency: `websocket-client==1.9.2` (Apache-2.0) in the `ingestion-deps` layer.
- AgentCore Browser is part of AgentCore Built-in Tools, available in the US, EU (including Frankfurt,
  eu-central-1) and Asia Pacific regions listed on the
  [AgentCore regions page](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html).
  The session runs in the Lambda's region. Where it is not available the run reports
  "AgentCore Browser is unavailable in <region>".
