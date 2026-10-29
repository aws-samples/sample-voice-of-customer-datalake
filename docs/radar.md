# Radar: other brands, kept apart from your own feedback

Radar monitors other brands, such as competitors, partners or the market. For each brand it shows:

- what their customers love and hate;
- their news (releases, product announcements, promotions, partnerships and company news), from web search, Exa and the brand's own feeds, with the sources cited;
- how they compare with you, per category of your own taxonomy.

Radar data appears only on the **Radar** page (`/radar`) and through the assistant's `get_radar` tool. It never reaches your dashboards, metrics, search, agents, research, memory or MCP.

## Turning it on

Two steps, both in the app: list the brands, then point review sources at them. The assistant can do both for you ("set up Radar for Acme").

1. **List the brands** in **Administration -> Sources -> Radar** (`/admin?tab=sources&section=radar`; admins reach it from the **Configure** link in the Radar page header, or from **Set up Radar** while no brand is tracked). Under **Brands tracked**, fill in **Add a brand**: the brand name and, optionally, its own website domains (at most 10, for example its site and blog; the news scan searches them), its **language** and its **feed URLs** (below), then **Save brands**. At most 25 brands.
   - **Language** (`language`): the language the brand publishes in, one of `en`, `pl`, `cs`, `sk`, `de`, `fr`, `es`, `it`, `pt`, `nl`, `sv`, `da`, `fi`, `no`, `hu`, `ro`, or empty for **auto**. Auto takes it from the first domain's top-level domain (`.pl` → Polish, `.cz` → Czech, `.sk` → Slovak, `.de` / `.at` / `.ch` → German, `.fr`, `.es`, `.it`, `.pt` / `.br` → Portuguese, `.nl`, `.se` → Swedish, `.dk` → Danish, `.fi`, `.no`, `.hu`, `.ro`), else English (`effective_language` in `GET /radar/brands`). The scan searches in that language and in English.
   - **Feed URLs** (`feed_urls`): at most 3 RSS 2.0 or Atom 1.0 feeds of the brand's news, each an `https` URL of at most 500 characters with a public host name (no credentials, no `#fragment`, no IP address). Only their shape is checked when saved; they are fetched at scan time only.
   - **Search terms** (`search_terms`) and **exclude terms** (`exclude_terms`), see [Search terms](#search-terms): at most 8 each, one per line, each 1-60 characters (no double quote, not starting with `-`).
   - A brand's key is its name folded to a slug (`Acme Corp` -> `acme-corp`), so the name needs at least one Latin letter or digit. Names that differ only in case or punctuation fold to the same key and are one brand.
   - Removing a brand stops its scans and hides it from the page; its stored reviews and releases are kept (re-adding it shows them again).
2. **Mark its review sources.** On the **Scrapers** page, tick **Radar source: reviews of another brand** and choose the brand on the source that collects its reviews: a custom scraper, a Web Reviews page, an iOS / Android app connector, or a CSV / JSON upload (pick the brand in the upload dialog). The source saves `radar_brand: <brand key>`. With no brand yet, the checkbox links back to **Administration -> Sources -> Radar**.
3. **Run that source.** Every new review from it goes to Radar under that brand, never to your dashboards.
4. **News** comes from the news scan over the brand list. It runs automatically on the scan cadence (checked daily), or now with **Scan now**: on the **Radar** page under the header (admins, once a brand is tracked) or in **Administration -> Sources -> Radar**. You can also ask the AI assistant to "scan now" or "look for news" (`run_radar_scan`, one approval card). The first scan looks back 90 days.

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
| `RELEASE#{brand}` | `{first_date}#{id}` | news record (`kind`, `found_via`) |
| `RADARSCAN` | `LOCK` / `LAST` | scan lock / latest scan outcome |
| `RADARSCAN#{brand}` | `STATE` | when the brand was last scanned (`last_scan_at`), where its query plan resumes (`query_cursor`) and the day each of its searches last ran (`since_by_step`: `<language>:<type>` such as `pl:features`, `own_domains`, `exa`) |
| `SETTINGS#radar` | `config` | the scan settings (Administration -> Sources -> Radar) |
| `SETTINGS#radar` | `brands` | the brand list `{brands: [{label, domains, language?, feed_urls?, search_terms?, exclude_terms?}], updated_at, updated_by}` (`lambda/shared/radar_brands.py`, `radar_brand_fields.py`, `radar_brand_terms.py`) |

The `voc-radar` table is in VocCoreStack: on demand, KMS, point-in-time recovery, retained on replacement, and protected by `-c protectData=true` like the other data tables.

## News: web search, Exa and the brand's feeds

`voc-radar-scan` (VocProcessingStack) files the NEWS of each brand: product releases and new features, product announcements and launches, promotions, partnerships, and company news, also when they are published outside the brand's own domains. Competitor sites are never crawled: the scan reads search results, the brand's feeds, and at most a few article pages (for a missing date).

**When it runs:**
- Once a day the worker checks whether a scan is due: Radar must track a brand (the brand list, or a legacy profile naming one), and the cadence must have elapsed.
- **Scan now** (admin, `POST /radar/scan`) ignores the cadence.
- Only one scan runs at a time.

**Sources:**
- **Web search**: the AgentCore web-search connector.
- **Exa** (exa.ai), a second index, once an admin stores an Exa API key (below). Small vendors' own sites and local press are often missing from the first index.
- **The brand's feeds** (`feed_urls`).

Without the web-search gateway, Exa key and feeds, a scan records `web_search_unavailable` and does nothing; with only some of them it uses those.

**The query plan.** Six kinds of query, each in the brand's effective language and then in English (once for an English brand): new features / release, launch / premiere, promotion / discount, partnership / integration, announcement, and company news. The first five quote the brand name; company news does not. The words per language are in `lambda/jobs/radar_scan/queries.py`. For a `.pl` brand "Acme":

| Type | Polish | English |
|---|---|---|
| features | `"Acme" nowe funkcje nowa wersja` | `"Acme" new features release` |
| launch | `"Acme" premiera` | `"Acme" launch` |
| promotion | `"Acme" promocja rabat` | `"Acme" promotion discount` |
| partnership | `"Acme" partnerstwo integracja` | `"Acme" partnership integration` |
| announcement | `"Acme" ogłasza` | `"Acme" announcement` |
| company news | `Acme aktualności` | `Acme news` |

A scan rarely affords all 12, so each brand keeps a cursor (`query_cursor`): a scan runs the plan from there and moves the cursor past the queries it ran, so successive scans cover every kind in turn. The brand's log line lists the types that ran (`pl:promotion`, …).

### Search terms

A brand's name can also be a common word. **Example Air** is the example: "air" is a common word, so `"Example Air" novinky` also finds articles about air quality in general. Two optional lists on the brand fix that (`lambda/shared/radar_brand_terms.py`, at most 8 each, each 1-60 characters after whitespace is folded, de-duplicated without regard to case; a double quote or a leading `-` is refused):

- **Search terms** (`search_terms`): words or phrases that name the company, such as its legal name (`Example Air Ltd`) and product names (`Example Air Miles`). They are added to every **general** news query as one group of quoted phrases, `("Example Air Ltd" OR "Example Air Miles")`, and to the Exa company-news query as plain words. The own-domain query and the Exa search on the brand's domains do not get them: those are already restricted to the brand's sites.
- **Exclude terms** (`exclude_terms`): words or phrases that mark a result as not about the brand (`air quality`). A result whose title or snippet contains one (case-insensitive) is dropped before any model call; when every result of a step is dropped, the step makes no model call. They are also sent to the providers: as `-"air quality"` on every web-search query, and the first one of at most five words as Exa's `excludeText` (Exa takes one phrase). The brand's log line counts the dropped results (`excluded`).

A query stays within the connector's 200 characters: terms are added whole, in the order given, as many as fit. For `"Example Air" nové funkce nová verze` with both lists above the web query is `"Example Air" nové funkce nová verze ("Example Air Ltd" OR "Example Air Miles") -"air quality"`. Whether a provider honours `OR` and `-"…"` is up to the provider; the exclude filter before the model call does not depend on it.

**Search windows** (`jobs/radar_scan/windows.py`). A scan runs only part of the plan, so each search keeps its own window instead of one "since the last scan" for the brand: each plan query (`pl:features`, `en:launch`, …), the own-domain step and the Exa step asks for what was published since the day THAT search last ran, never more than 90 days back. A search that has never run (a new brand, a query type the rotation has not reached yet, Exa just configured) looks back 90 days. Feeds cost nothing extra to read again, so they always take the whole 90 days. A search that failed keeps its old window. A state row stored before 5.42.01 has no `since_by_step`, so every search looks back 90 days on the next scan. Windows overlap, and an item found again is merged into its record (see Dedupe), never filed twice.

**Steps per brand, in order.** Each step stops once the brand's share of the query cap is used. A web search, an Exa search and a feed fetch each cost 1.

1. **Feeds**: each feed URL, fetched only through the SSRF-guarded opener (`shared/http_utils.fetch_public_url`: https, at most 2 MB, 15 s, at most 3 redirects, every hop checked by the URL policy). A document that declares a `DOCTYPE` or an `ENTITY` is refused before it is parsed, and so is one that is not ASCII-compatible. RSS 2.0 and Atom 1.0 are read. The scan takes at most 30 items dated within the last 90 days (`pubDate` / `published` / `updated`) with an `https` link: the item's link is its citation, never the feed URL. A feed that fails is logged with its host only.
2. **News**: the next third of the brand's share (at least 1) of the rotated plan, each query published since that query last ran (90 days when it never ran).
3. **Own domains**: only when step 2 found no dated item and the brand has domains. One company-news query in the brand's language, restricted to its own domains, with **no** published-date filter, because a vendor's news pages are often undated. They are dated as described under "Missing dates" below.
4. **Exa**: only when a key is stored and steps 2 and 3 found no dated item. One search on the brand's domains (when it has some) and one company-news search in its language, both published since the Exa step last ran (90 days when it never ran). An Exa error is logged without the key, and the brand's scan goes on.
5. **More news**: the rest of the share continues the rotated plan.

Anything dated more than 90 days ago is not filed, whichever step found it. Each brand logs one line with counts per source (`web`, `exa`, `feed`) and per kind, never page text or the key. Our own brand name is no longer searched (`<brand> vs <us>` was dropped in 5.42).

**What happens to the results:**
- One model call per step that has results (the `utilities` surface) turns them into news items: a short headline (`feature`), its `kind`, the date, and a short summary in the model's own words, in English whatever the results' language. The results reach the model only inside a `web_results` data block. The model keeps only news of that company itself: rumours, other companies, job posts and generic articles about the topic its name is about are ignored.
- **Kinds** (`kind`): `release` (a product release, new feature or version), `announcement` (a product announcement, launch, roadmap, beta), `promotion` (prices, discounts, campaigns), `partnership` (partners, integrations announced as a partnership, acquisitions), `news` (other company news: results, awards, people, events). An unknown kind is filed as `news`. A record stored before 5.42 reads as `release`.
- **Found via** (`found_via`): the sources that found it, `web`, `exa` and / or `feed` (a record from before 5.42 reads `["web"]`). A merge keeps the earlier kind (unless it had none) and unions `found_via`.
- No search snippet is stored. A record keeps our summary, the cited URLs and titles, `source_kind` (`official` when a URL is on the brand's domains, otherwise `third_party`), `mentions`, `first_seen` and `last_seen`.
- **Missing dates.** A release without a date takes its cited result's published date, then a date written in a cited URL's path (`/changelog/2026-07-30-…`, `/blog/2026/07/30/…`). If that is missing too, the article page is fetched once, through the SSRF-guarded opener (`shared/http_utils.fetch_public_url`), and its published-date metadata is read. A scan fetches at most 5 pages. With no date found, the release is first matched against the brand's whole timeline (so an undated mention joins the dated record of the same feature); a new one is dated by first sighting, flagged `date_approximate`, and shown as "Date not published, first found <day>" (the assistant says "first found <day>").
- **Dedupe.** Two checks against the brand's releases within ±60 days (an undated item: the whole timeline), in order. First, the **same page**: a release that already cites one of the item's pages (the same page however it is spelled: `www.`, a trailing slash, query order and tracking parameters do not count, as under "Clean citations") is the same story, however differently the two sources word it. A page that lists many stories never decides this (`lambda/shared/radar_listing_pages.py`), so two stories that both cite `example.com/aktualnosci/programy.html` stay two records: the home page (`/` without a query), a `page` / `paged` / `offset` / `start` query parameter, a last path segment that is a section word (`news`, `blog`, `press`, `newsroom`, `changelog`, `aktualnosci`, `novinky`, `nachrichten`, `actualites`, `noticias`, … in the scan's languages), a `category` / `tag` / `topic` / `author` / `archive` / `page` segment, a date archive ending in a year or a year and month (`/2026/10/`), one plain word with no `-`, `_` or digit under a section word (`/aktualnosci/programy.html`, `/news/products`), and a page two or more stored records of the brand already cite. Such a page still counts as a citation, and the embedding check still runs. A one-word article under a section (`/blog/loops`) loses only this shortcut. Otherwise the headline is embedded with Titan V2, and a cosine of at least 0.86 matches. A match merges the two: URLs and titles are unioned, `found_via` is unioned and `mentions` goes up. The record keeps its kind, and an official source wins the feature name and the date.
- **Clean citations** (`shared/radar_citations.py`). Before a release is stored, and again when the releases route answers (so older records show clean too), its links are cleaned. The host is lower-cased, and the `#fragment` and tracking parameters (`utm_*`, `gclid`, `fbclid`, …) are dropped. Links that differ only by `http`/`https`, a leading `www.`, a trailing slash or query order count as one page, so each page is listed once, with its title beside it. Links on `https` are listed before `http` ones. An `http` link is kept, because whether the site serves `https` is not known. Machine feeds are never shown as a citation: a path that ends in `.json`, `.xml`, `.rss` or `.atom`, or that has a `rss`, `feed`, `feeds` or `atom` segment (`example-air.example/rss/changelog.json`). A feed can still date a release or mark it official. A release whose only sources are feeds is not filed. A link without a title shows its host.

**Exa.** Admins store the key in **Administration -> Sources -> Radar** (`PUT /radar/settings/exa-key {api_key}`; `DELETE` removes it; `settings.exa_configured` says whether one is stored). The key is kept as an SSM Parameter Store **SecureString** (standard tier, so no monthly cost; encrypted with the AWS-managed `alias/aws/ssm` key) named `/voc/radar/exa-api-key`, or `/<prefix>-voc/radar/exa-api-key` on a prefixed deployment. The Radar API creates the parameter on the first save and deletes it on removal; CloudFormation never creates it. The key is never returned, logged or put in an error message. Only `voc-radar-api` (put, delete, and a read without decryption) and `voc-radar-scan` (a decrypted read) may touch that one parameter.
- **What leaves AWS:** only the brand's name, the search words and its domains, sent to `https://api.exa.ai/search` with the key. No feedback, no review text, no user data.
- **Cost:** pay-per-use, about **$5 per 1,000 Exa searches** (exa.ai pricing). A scan runs at most 2 per brand, within the query cap. Nothing is paid without a key.
- Removing the stack leaves a stored key parameter behind: remove the key first (or delete the parameter).

**Requirements:**
- The search filters need web-search connector **1.2.0** or later. `VocWebSearchStack` pins the gateway target with a custom resource (`lib/stacks/web-search-connector-pin.ts`, `UpdateGatewayTarget` with `source.version`), because the CloudFormation `ConnectorSource` schema has no version field.
- The update is in place: the target keeps its name, so the tool name `web-search-tool___WebSearch` does not change.
- Without the web-search gateway the web steps are skipped (Exa and feeds still run when available).

## Administration -> Sources -> Radar

`/admin?tab=sources&section=radar`, admins only. From top to bottom:

- **Brands tracked** (`GET /radar/brands`, saved whole with `PUT /radar/brands`): each brand with its origin (**Brand list** or **Source profile**), its 90-day review count (from `GET /radar`), its domains, its search language and its news feeds and, for a legacy brand, the source profiles naming it. **Edit** opens a brand's domains, **Search language** (**Auto (from the domain: Polish)** names the `effective_language` the server derived; or one of 16 languages, named in the UI language) and **News feeds** (up to 3 https RSS / Atom links, one per line or comma separated; a fourth or a non-https link holds **Save brands** back), **Search terms** and **Exclude terms** (one per line; a ninth term, one over 60 characters, a double quote or a leading `-` holds **Save brands** back) in place; **Remove** (list brands only) asks first and says what happens: its stored reviews and releases are kept, the release scan stops searching for it, and sources still set to it stop importing until they get another brand. **Add a brand** takes a name and domains, and the same language, feeds and terms under **More options**. Nothing is written until **Save brands**; a refused save shows the server's reason.
- **How Radar works**: the three steps of [Turning it on](#turning-it-on), in short.
- The scan settings (`PUT /radar/settings`):

| Setting | Default | Range |
|---|---|---|
| Scan cadence | weekly | daily, weekly, monthly |
| Brands per scan | 10 | 1-25 (the first ones: the brand list in order, then legacy profile brands) |
| Web searches per scan | 30 | 1-100, shared equally between the brands (at least 1 each); web searches, Exa searches and feed fetches all count |
| Exa API key | none | optional; `exa_configured` shows whether one is stored |

**Exa (second search index)**, below the scan settings: whether an Exa API key is stored (**Configured** / **Not configured**, from `settings.exa_configured`), a password box with **Save key** (`PUT /radar/settings/exa-key`; the box is cleared after a save and the key is never shown back) and, once stored, **Remove key** behind a confirm (`DELETE`).

The tab also shows the last scan and the **Scan now** button.

## The Radar page

One view per brand, chosen with a selector, over 30, 90 or 365 days:

- **Sentiment trend:** reviews per day and the average sentiment.
- **Love / hate:** the top praise and complaint themes (category / subcategory) with counts and up to 3 quotes each. Quotes are PII-redacted again on the way out.
  - Themes are read from up to the 1,000 newest reviews of the window.
  - Categories the user may not see are left out.
- **News and releases:** a timeline, newest first. Each item shows its kind (**Release**, **Announcement**, **Promotion**, **Partnership** or **Company news**), its date (or "Date not published, first found <day>"), official or press, its mentions, a muted **via Exa** / **via feed** when our own web search did not find it, our summary, and links to every source. Chips above the list (**All** and the five kinds) filter it on the page; the All brands feed has the same chips.
- **Compared with us:** per category where the brand has reviews, their positive share and volume against yours, and a verdict ("they are better", "we are better" or "even", with a 10-point margin).
  - Your side comes from your aggregates, and only for categories you may see.
  - A user whose source access hides one of your own sources gets no "us" side, because the aggregates cannot be split by source.

**All brands.** With two brands or more, the selector's first choice is **All brands** (`?brand=all`,
shareable; the page still opens on the first brand without one), read with `GET /radar/all` for the
same window. A **Brands** table lists every brand (reviews, sentiment in words with the positive and
negative shares, releases in the window, latest news with its kind); a brand's name opens its own view. Below it,
**Latest news across brands** is the releases timeline for every brand at once, newest first, each
item naming its brand. When there are more than 100, it says "Showing the newest 100 of N". On a
phone the table scrolls sideways inside its card.
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
| GET | `/radar/all?days=` | signed in | "All brands": every visible brand with its totals over `days`, `releases_in_window` and `latest_release`, then one release feed of every brand (`brand: {key, label}`, newest first, at most 100; `releases_total` / `releases_capped` say when there were more). `releases_total` and each brand's `releases_in_window` are exact: a brand whose read reaches 100 records is counted with one `Select=COUNT` query (5.47; before, a brand with more than 100 releases in the window made the total a lower bound). A brand label whose key would be `all` is refused when the brand list is saved |
| GET | `/radar/brands` | signed in | the effective brands `{brands: [{key, label, domains, origin: 'list'\|'profile', sources, language, effective_language, feed_urls, search_terms, exclude_terms}]}`: the list in order, then legacy profile brands (`language` null = auto) |
| PUT | `/radar/brands` | admin | replace the list: body `{brands: [{label, domains?, language?, feed_urls?, search_terms?, exclude_terms?}]}` -> `{success, brands}` (the GET shape). At most 25 brands, unique keys, at most 10 domains, 3 feed URLs, 8 search terms and 8 exclude terms each, a language from the list above or empty / `auto`; 400 with the reason otherwise. Never deletes stored reviews or releases |
| GET | `/radar/brands/{brand}?days=` | signed in | totals, trend, love / hate |
| GET | `/radar/brands/{brand}/releases?days=` | signed in | news items (default 365 days, at most 50), each with `kind` and `found_via` |
| GET | `/radar/brands/{brand}/compare?days=` | signed in | per-category comparison (their volume counts distinct reviews, like the list) |
| GET | `/radar/brands/{brand}/page?days=` | signed in | what the Radar page reads for a brand, in one request: `{detail, releases, compare}` = the three answers above (releases over their own 365 days); one read of the brand list and profiles. The page used to ask for the three at once, which made a cold `voc-radar-api` start a second environment ([caching.md → First load](caching.md#first-load)) |
| GET | `/radar/brands/{brand}/reviews?days=&category=&subcategory=&sentiment=&day=&cursor=&limit=` | signed in | the reviews themselves, newest first (below) |
| GET | `/radar/brands/{brand}/reviews/{feedback_id}` | signed in | one review for the review modal: `{brand: {key, label}, review}` = the list fields plus `persona_name`, `persona_type`, `journey_stage`, `impact_area`, `problem_root_cause_hypothesis`, `source_created_at`, `source_channel`, `language` when set (redacted like the list, never the author). 404 when absent, of a hidden brand, or in a category the caller may not see |
| GET / PUT | `/radar/settings` | GET signed in, PUT admin | the scan settings; GET adds `exa_configured` (also in `GET /radar` `settings`) |
| PUT / DELETE | `/radar/settings/exa-key` | admin | store `{api_key}` (8-200 of `A-Za-z0-9_-`) / remove the Exa key -> `{success: true, exa_configured}`; the key is never returned |
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
- The assistant's `get_radar` (core pack, read-only) calls these routes as the user. In its view `brands` each brand's
  `sources` is passed on as `profile_sources` with a note: it lists only legacy source profiles, so a brand fed by
  scrapers, review pages or app connectors (`radar_brand`) shows an empty list. To check that an import reached Radar,
  the assistant reads the run (`get_source_run`) and the per-brand review totals (`get_radar` without a brand).
  - `list_scrapers` (scrapers pack) lists the scrapers AND, as `connectors`, every iOS / Android app connector and
    Web Reviews page with the `radar_brand` it feeds (5.47). It reads `GET /scrapers/connectors` on the scrapers API
    (the same configs `GET /integrations/<source>/apps` returns to any signed-in user, only `source, id, app_name,
    app_id, package_name, url, enabled, frequency_minutes, source_id, radar_brand`), because the assistant may invoke
    the scrapers API and not the integrations API. `save_radar_brands` may set `search_terms` and `exclude_terms`
    (same bounds as the route; a brand the card names none for keeps its stored ones).
  - With a brand and no view it answers in ONE call: the summary, the newest 12 releases and the comparison together (the three routes read in parallel).
  - Each release reaches the model as ready-made markdown `links` ("Coding sessions · Jun 11"): https only (an `http` link is upgraded), one per page across the list, no raw `urls` / `titles`. A compare row with fewer than 10 of their reviews carries `small_sample: true`, and the system prompt asks the answer to say so.
- `get_radar` is not available to plan think steps or on `/mcp/global`.

## Cost

- Nothing runs without a Radar brand: the daily tick is two settings reads.
- A scan costs at most `query_cap` paid calls (web searches, Exa searches at about $5 per 1,000, feed fetches), at most 5 model calls per brand (one per step with results), one embedding per item found, and at most 5 article page fetches.
- The Exa key is a standard SSM parameter: no monthly cost.
- Reviews of a Radar source cost the same enrichment as your own.
