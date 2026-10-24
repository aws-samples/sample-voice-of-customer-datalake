# Radar: other brands, kept apart from your own feedback

Radar monitors other brands, such as competitors, partners or the market. For each brand it shows:

- what their customers love and hate;
- what they have released, from web search, with the sources cited;
- how they compare with you, per category of your own taxonomy.

Radar data appears only on the **Radar** page (`/radar`) and through the assistant's `get_radar` tool. It never reaches your dashboards, metrics, search, agents, research, memory or MCP.

## Turning it on

Two steps, both in the app: list the brands, then point review sources at them. The assistant can do both for you ("set up Radar for Acme").

1. **List the brands** in **Administration -> Sources -> Radar** (`/admin?tab=sources&section=radar`; admins reach it from the **Configure** link in the Radar page header, or from **Set up Radar** while no brand is tracked). Under **Brands tracked**, fill in **Add a brand**: the brand name and, optionally, its own website domains (at most 10, for example its site and blog; the release scan uses them to find release notes), then **Save brands**. At most 25 brands.
   - A brand's key is its name folded to a slug (`Acme Corp` -> `acme-corp`), so the name needs at least one Latin letter or digit. Names that differ only in case or punctuation fold to the same key and are one brand.
   - Removing a brand stops its scans and hides it from the page; its stored reviews and releases are kept (re-adding it shows them again).
2. **Mark its review sources.** On the **Scrapers** page, tick **Radar source: reviews of another brand** and choose the brand on the source that collects its reviews: a custom scraper, a Web Reviews page, an iOS / Android app connector, or a CSV / JSON upload (pick the brand in the upload dialog). The source saves `radar_brand: <brand key>`. With no brand yet, the checkbox links back to **Administration -> Sources -> Radar**.
3. **Run that source.** Every new review from it goes to Radar under that brand, never to your dashboards.
4. **Releases** come from the news scan over the brand list. It runs automatically on the scan cadence (checked daily), or now with **Scan now** in **Administration -> Sources -> Radar**. The first scan looks back 90 days.

The source's own profile still applies as for any other source: PII policy (`redact` is recommended for another brand's customers) and restriction.

- Radar items are not deleted by `voc-retention` (retention and erasure cover `voc-feedback`). If a Radar brand's data needs deleting, remove its items from `voc-radar`.

Nothing runs and nothing costs until a brand is listed (or a legacy profile names one).

### Legacy: Radar brands on source profiles

Before the brand list, a source profile became a Radar source with **Radar source: tracks another brand** (`radar_brand`, `radar_domains` on the profile). Those profiles keep working: every brand a profile names is merged into the list by key (`origin: 'profile'` in `GET /radar/brands`, shown as "Source profile" under **Brands tracked**), its reviews keep routing to it, and the scan covers it. A profile brand that is also listed keeps the list's name and gains the profile's domains; loading one is not an unsaved change, and the next **Save brands** (after a real edit) writes it into the list. A **restricted** legacy profile still hides its brand from users who have not been granted that source. Source policies no longer offer the checkbox; a profile that already names a brand shows it read-only.

## How Radar data stays out of your numbers

The brand of a review is decided at ingestion:

- **Stamped sources.** A scraper (`webscraper_configs[].radar_brand`), a Web Reviews target or app connector (`<plugin>_configs[].radar_brand`) or a CSV upload (`radar_brand` in the `POST /scrapers/manual/csv-upload` body) names a brand key. The save routes accept only a key (`^[a-z0-9][a-z0-9_-]{0,63}$`; blank = an ordinary source; anything else is a 400). The ingestor stamps every queue message with `radar_brand_key` (`IngestMessage.radar_brand_key`, same pattern). Only server-built producers set it; the public feedback form and manual paste never do.
- **The processor** (`lambda/processor/handler.py`, `lambda/shared/radar_routing.py`) resolves a stamped key against the effective brands (the list, read from `voc-radar` at most once a minute per container and once more on a miss, then the legacy profile brands). A stamped key wins over the source profile.
- **Legacy profiles.** An unstamped message whose source profile names a brand (`radar_brand`) goes to that brand, as before.

A Radar review goes through the same enrichment as your own: language, translation, sentiment, category and the PII policy. It is then written **only** to the `voc-radar` table, never to `voc-feedback`, so the aggregator, the dashboards, the metrics routes, search, agents and MCP never see it.

- **Fail-closed reads.** If the source profiles or the brand list cannot be read, the processor stores nothing, anywhere, and SQS retries the message. A stamped key that no brand has (`UnknownRadarBrandError`) and a malformed key (refused by the queue schema) are retried too and then land in the processing DLQ: never in `voc-feedback`. Re-add the brand and redrive the DLQ to recover them.
- **One transaction per review.** The review, a dedupe marker and its daily counters are written together. A redelivered message never double-counts.

Table layout (`lambda/shared/radar_store.py`, `lambda/shared/radar_releases.py`):

`{day}` is the day the review was **written** (its `source_created_at`, else the import day), so a backfill of another brand's review history keeps its real trend instead of piling onto the import day.

| pk | sk | What |
|---|---|---|
| `RADAR#{brand}#ITEMS#{YYYY-MM}` | `{day}#{feedback_id}` | enriched review |
| `RADARID#{brand}` | `{feedback_id}` | dedupe marker |
| `RADAR#{brand}#{metric}` | `{day}` | daily counter (`daily_total` with `sentiment_sum`, `daily_sentiment#…`, `daily_category#…`, `category_sentiment#…#…`) |
| `RELEASE#{brand}` | `{first_date}#{id}` | release record |
| `RADARSCAN` | `LOCK` / `LAST` | scan lock / latest scan outcome |
| `RADARSCAN#{brand}` | `STATE` | when the brand was last scanned |
| `SETTINGS#radar` | `config` | the scan settings (Administration -> Sources -> Radar) |
| `SETTINGS#radar` | `brands` | the brand list `{brands: [{label, domains}], updated_at, updated_by}` (`lambda/shared/radar_brands.py`) |

The `voc-radar` table is in VocCoreStack: on demand, KMS, point-in-time recovery, retained on replacement, and protected by `-c protectData=true` like the other data tables.

## Releases: from our web search only

`voc-radar-scan` (VocProcessingStack) reads only the AgentCore web-search connector. Competitor sites are never crawled.

**When it runs:**
- Once a day the worker checks whether a scan is due: Radar must track a brand (the brand list, or a legacy profile naming one), and the cadence must have elapsed.
- **Scan now** (admin, `POST /radar/scan`) ignores the cadence.
- Only one scan runs at a time.

**Searches per brand, in order.** Each step stops once the brand's share of the query cap is used.

1. `"<brand>" new features` and `"<brand>" release`, published since the brand's last scan. The first scan looks back 90 days.
2. Only when step 1 found no dated release, and the brand has domains: the same window, restricted to the brand's own domains.
3. Broader coverage: press, and `<brand> vs <your brand>`.

**What happens to the results:**
- One model call per step (the `utilities` surface) turns the results into releases: feature, date, and a short summary in the model's own words. The results reach the model only inside a `web_results` data block.
- No search snippet is stored. A record keeps our summary, the cited URLs and titles, `source_kind` (`official` when a URL is on the brand's domains, otherwise `third_party`), `mentions`, `first_seen` and `last_seen`.
- **Missing dates.** A release without a date takes its cited result's published date. If that is missing too, the article page is fetched once, through the SSRF-guarded opener (`shared/http_utils.fetch_public_url`), and its published-date metadata is read. A scan fetches at most 5 pages. With no date found, the release is dated by first sighting and marked approximate.
- **Dedupe.** The feature name is embedded with Titan V2. A cosine of at least 0.86 with an existing release of the same brand, within ±60 days, merges the two: URLs and titles are unioned and `mentions` goes up. An official source wins the feature name and the date.
- **Clean citations** (`shared/radar_citations.py`). Before a release is stored, and again when the releases route answers (so older records show clean too), its links are cleaned. The host is lower-cased, and the `#fragment` and tracking parameters (`utm_*`, `gclid`, `fbclid`, …) are dropped. Links that differ only by `http`/`https`, a leading `www.`, a trailing slash or query order count as one page, so each page is listed once, with its title beside it. Links on `https` are listed before `http` ones. An `http` link is kept, because whether the site serves `https` is not known. Machine feeds are never shown as a citation: a path that ends in `.json`, `.xml`, `.rss` or `.atom`, or that has a `rss`, `feed`, `feeds` or `atom` segment (`example-air.example/rss/changelog.json`). A feed can still date a release or mark it official. A release whose only sources are feeds is not filed. A link without a title shows its host.

**Requirements:**
- The search filters need web-search connector **1.2.0** or later. `VocWebSearchStack` pins the gateway target with a custom resource (`lib/stacks/web-search-connector-pin.ts`, `UpdateGatewayTarget` with `source.version`), because the CloudFormation `ConnectorSource` schema has no version field.
- The update is in place: the target keeps its name, so the tool name `web-search-tool___WebSearch` does not change.
- Without the web-search gateway, a scan records `web_search_unavailable` and does nothing.

## Administration -> Sources -> Radar

`/admin?tab=sources&section=radar`, admins only. From top to bottom:

- **Brands tracked** (`GET /radar/brands`, saved whole with `PUT /radar/brands`): each brand with its origin (**Brand list** or **Source profile**), its 90-day review count (from `GET /radar`), its domains and, for a legacy brand, the source profiles naming it. **Edit domains** edits a brand's domains in place; **Remove** (list brands only) asks first and says what happens: its stored reviews and releases are kept, the release scan stops searching for it, and sources still set to it stop importing until they get another brand. **Add a brand** takes a name and domains. Nothing is written until **Save brands**.
- **How Radar works**: the three steps of [Turning it on](#turning-it-on), in short.
- The scan settings (`PUT /radar/settings`):

| Setting | Default | Range |
|---|---|---|
| Scan cadence | weekly | daily, weekly, monthly |
| Brands per scan | 10 | 1-25 (the first ones: the brand list in order, then legacy profile brands) |
| Web searches per scan | 30 | 1-100, shared equally between the brands (at least 1 each) |

The tab also shows the last scan and the **Scan now** button.

## The Radar page

One view per brand, chosen with a selector, over 30, 90 or 365 days:

- **Sentiment trend:** reviews per day and the average sentiment.
- **Love / hate:** the top praise and complaint themes (category / subcategory) with counts and up to 3 quotes each. Quotes are PII-redacted again on the way out.
  - Themes are read from up to the 1,000 newest reviews of the window.
  - Categories the user may not see are left out.
- **Releases:** a timeline, newest first. Each release shows its date (or "approximate"), official or press, its mentions, our summary, and links to every source.
- **Compared with us:** per category where the brand has reviews, their positive share and volume against yours, and a verdict ("they are better", "we are better" or "even", with a 10-point margin).
  - Your side comes from your aggregates, and only for categories you may see.
  - A user whose source access hides one of your own sources gets no "us" side, because the aggregates cannot be split by source.

**Also on Home.** The morning brief carries up to 3 Radar cards (a tracked brand's new releases
since the previous brief, a clear rise in its complaints, and "where they beat us"), each with
**Open Radar** to this page for the brand. Same visibility rules as here. See
[briefing.md](briefing.md#radar-cards).

### Reading the reviews

Every number on the page opens the reviews behind it, in a **"<brand> reviews"** dialog:

| Click | Opens |
|---|---|
| A love / hate theme ("Read the N reviews") or one of its quotes | that category and subcategory, positive (love) or negative (hate); a theme without a subcategory lists only the reviews without one |
| **Read all reviews** in the totals line | every review in the window |
| A bar of the sentiment trend, or a day under **Read a day's reviews** (the keyboard route) | that day's reviews |
| A category's **Them** cell in "Compared with us" | the brand's reviews in that category |

- The active filters show as chips (category, subcategory, sentiment, day). Each one clears on its own; clearing the category also clears its subcategory. A sentiment select narrows further.
- Each review shows its date, sentiment, category / subcategory, rating, the whole text ("Show more" for long ones), the problem summary and a link to its source page (web links only).
- 25 reviews at a time; **Load more** continues.
- The texts are PII-redacted again on the way out, like the quotes. Author names and emails are never sent.
- Categories the user may not see are never listed.

With no Radar source yet, the page explains how to add one. Admins get a **Set up Radar** link there, and a **Configure** link in the page header at all times, both to **Administration -> Sources -> Radar**.

## API (`voc-radar-api`)

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/radar` | signed in | brands (`key`, `label`, `domains`, `origin`, `sources` = the legacy source profile ids naming the brand) with 90-day totals, last scan, settings |
| GET | `/radar/brands` | signed in | the effective brands `{brands: [{key, label, domains, origin: 'list'\|'profile', sources}]}`: the list in order, then legacy profile brands |
| PUT | `/radar/brands` | admin | replace the list: body `{brands: [{label, domains?}]}` -> `{success, brands}` (the GET shape). At most 25 brands, unique keys, at most 10 domains each; 400 otherwise. Never deletes stored reviews or releases |
| GET | `/radar/brands/{brand}?days=` | signed in | totals, trend, love / hate |
| GET | `/radar/brands/{brand}/releases?days=` | signed in | releases (default 365 days, at most 50) |
| GET | `/radar/brands/{brand}/compare?days=` | signed in | per-category comparison (their volume counts distinct reviews, like the list) |
| GET | `/radar/brands/{brand}/reviews?days=&category=&subcategory=&sentiment=&day=&cursor=&limit=` | signed in | the reviews themselves, newest first (below) |
| GET | `/radar/brands/{brand}/reviews/{feedback_id}` | signed in | one review for the review modal: `{brand: {key, label}, review}` = the list fields plus `persona_name`, `persona_type`, `journey_stage`, `impact_area`, `problem_root_cause_hypothesis`, `source_created_at`, `source_channel`, `language` when set (redacted like the list, never the author). 404 when absent, of a hidden brand, or in a category the caller may not see |
| GET / PUT | `/radar/settings` | GET signed in, PUT admin | the scan settings |
| POST | `/radar/scan` | admin | start a scan (202; 400 "No Radar brand yet" while nothing is tracked); the last scan is `last_scan` on `GET /radar` |

- A brand the caller may not see is answered 404. A listed brand no legacy profile names is visible to every signed-in user; one that a restricted legacy profile names is visible only to callers granted that source.
- Every route sits under the existing `/radar` and `/radar/{proxy+}` resources: no new API Gateway resources.

**`GET /radar/brands/{brand}/reviews`** (`lambda/shared/radar_reviews.py`):
- Reads the brand's month partitions newest first, over `days` (default 90, at most 365), and filters in code.
- `category`: one category. A category the caller may not see answers an empty list.
- `subcategory`: one subcategory. An empty value (`subcategory=`) means "reviews without a subcategory".
- `sentiment`: `positive`, `negative`, `neutral` or `mixed`.
- `day=YYYY-MM-DD`: that one day, which must be inside the `days` window.
- `limit`: default 25, capped at 50.
- Answer: `{brand, reviews, next_cursor, limit}`. Each review is `{feedback_id, day, text, sentiment_label, sentiment_score, category, subcategory, source_platform}`, plus `title`, `quote`, `rating`, `urgency`, `problem_summary` and `source_url` (http(s) only) when set.
  - The texts are pattern-redacted and clipped (text 5,000 characters, the others 500).
  - Never `author` or an email.
  - `day` is the day the review was written (`radar_day`; for a row stored before `radar_day` existed, computed the same way from `source_created_at`), the date the review modal shows too. The modal adds a labelled "Source date" only when the source's own timestamp names another day.
  - The same review stored twice (same text and written day, e.g. a file imported twice) is listed once per page. Both stored copies are kept; nothing is deleted.
  - The counts on the page come from that same reading: the brand total and per-sentiment counts (`GET /radar`, `GET /radar/brands/{brand}`), the daily trend, and each love / hate theme's count. So a second stored copy counts once, the counts follow the caller's category access like the list does, and "Read the 2 reviews" opens 2 (`shared/radar_counts.py`). A window holding more than 2,000 stored reviews falls back to the daily counters, which count every stored copy. A review with no text is never merged with another one.
- Paging: `next_cursor` is opaque base64url JSON of the last review's key. Pass it back as `cursor`; it is `null` at the end.
  - A request reads at most 1,000 stored reviews. A sparse filter can therefore answer fewer reviews (even none) with a cursor to go on.
  - A cursor that does not decode, names another brand or partition, or falls outside the window is a 400. So are an unknown sentiment and a malformed or out-of-window day.
- The assistant's `get_radar` (core pack, read-only) calls these routes as the user.
  - With a brand and no view it answers in ONE call: the summary, the newest 12 releases and the comparison together (the three routes read in parallel).
  - Each release reaches the model as ready-made markdown `links` ("Coding sessions · Jun 11"): https only (an `http` link is upgraded), one per page across the list, no raw `urls` / `titles`. A compare row with fewer than 10 of their reviews carries `small_sample: true`, and the system prompt asks the answer to say so.
- `get_radar` is not available to plan think steps or on `/mcp/global`.

## Cost

- Nothing runs without a Radar brand: the daily tick is two settings reads.
- A scan costs at most `query_cap` web searches, at most 3 model calls per brand, one embedding per release found, and at most 5 page fetches.
- Reviews of a Radar source cost the same enrichment as your own.
