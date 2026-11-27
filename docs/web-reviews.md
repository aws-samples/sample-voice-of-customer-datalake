# Web reviews (generic review-page plugin)

The `web_reviews` plugin reads customer reviews from **public review pages**, such as a company page on a review
site, a travel listing or a forum. By default (`auto`, [Methods](#methods)) it reads a page with the deployment's
signed managed browser, and when the site blocks it or it reads no review, from the Amazon Bedrock web search
index, then from AgentCore Web Search's snippets (as excerpts); each workspace learns which method reads each site
([Learning which method works](#learning-which-method-works)). It imports the reviews through the normal pipeline
(source policy, raw archive, processing queue). It is site-agnostic: nothing in it knows a particular site.
Administrators add pages; every page becomes its own source.

It is **on by default** (`pluginStatus.web_reviews: true` in `voc-datalake/cdk.context.json`) and does nothing
until an administrator adds a page.

## Adding pages

- **Data sources** (`/scrapers`) → **New source** → **A website link** → **Review page**: add a page with a name,
  its `https` URL, how to read it (**Read with**: Automatic (recommended), the default; Browser only; Bedrock web
  index only; [Methods](#methods)), how much to read (pages
  per run, 0-100, default 10; reviews per run, 0-5,000, default 0; see [Reading modes](#reading-modes)) and a run
  frequency (manual only by default). The **Amazon Bedrock web search index** source presets Bedrock web index
  only. Each page is listed under **Review pages** with Run now, Edit, Delete and the last run's status, which says
  how the page was read ("Browser blocked by Cloudflare → read via Bedrock web index (11 reviews)", an
  **excerpts** badge when AgentCore Web Search's snippets read it), and, for an Automatic page, the method this
  workspace learned for its site with **Re-check methods** (administrators).
- **AI assistant** (administrators): `create_app_connector` with `source: "web_reviews"`, `url` and optionally
  `max_pages` / `max_reviews`, approved on a card; the page is saved with the default method, `auto`. Before it
  proposes one it reads `list_review_site_methods` (what this workspace learned of each site, through `GET
  /scrapers/review-methods`) and says what is known of the page's site, or that its first run will learn it; it never
  claims a site's method the workspace has not recorded, and it does not propose Yelp or Reddit pages (their official
  APIs only). In plan mode the assistant can find review pages with web search
  (`plan_lookup`), list each chosen URL as its own write on the plan card, then `run_source web_reviews` and wait
  for the run ([assistant-plan-mode.md](assistant-plan-mode.md)). It proposes only a URL copied from a web search
  result that names the company (one search per site), never a URL built from a name, and says when a site has no
  page for it ([scrapers.md → With the AI assistant](scrapers.md#with-the-ai-assistant-administrators)).
- **API**: `POST /integrations/web_reviews/apps` with `{"app": {"app_name", "url", "max_pages"?,
  "max_reviews"?, "frequency_minutes"?, "enabled"?, "method"?, "model"?}}` (admin). The target is validated before it is saved
  (`lambda/shared/web_review_targets.py`): https only, the host must resolve to public addresses only (the shared
  outbound URL policy / SSRF guard), `max_pages` 0-100, `max_reviews` 0-5000 (both stored as strings),
  `frequency_minutes` one of 0, 15, 30, 60, 180, 360, 720,
  1440; `method` `auto` (the default since 7.44.00; absent means `auto`), `browser` or `bedrock_web_search`
  (anything else is a 400 naming the three); a stored `browser` or `bedrock_web_search` is kept as it is (7.41.00 and
  7.42.00 stored `browser` on every page they saved, so those pages stay Browser only until edited); unknown fields
  are dropped. `model` (7.41.00) is accepted and dropped like them: since 7.42.00
  the model that reads a `bedrock_web_search` page is no page's but the web search surface's, chosen in
  Administration → AI models ([Methods](#methods)), so neither form asks for one. Targets are stored like the app connectors, as `web_reviews_configs` in the
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
   deployment's own Web Bot Auth browser (`voc_web_reviews`; the AWS-managed `aws.browser.v1` with
   `-c webReviewsBotAuth=false`; [Blocked sites](#blocked-sites)) from its browser profile
   ([Sessions and profiles](#sessions-and-profiles)), connects to its automation stream (a SigV4-signed websocket)
   and drives it over the Chrome DevTools Protocol. The session timeout ends with the Lambda's own time; the
   session is saved into the profile and then **always** stopped (`StopBrowserSession`) in a `finally`. The
   browser announces itself honestly: its User-Agent contains `Amazon-Bedrock-AgentCore-Browser`; nothing is
   spoofed ([Honesty rules](#honesty-rules)). Targets whose method is `bedrock_web_search` are not read in the
   browser, and a run of those only starts no session. An `auto` target is read in three phases: the steps its
   learned plan puts before the browser (a site the workspace reads through web search), then the one session for
   every target that needs the browser, then the steps after it ([Methods](#methods)).
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
4. **Items.** The same review read again gets the same `id`, so the processor deduplicates it (an id already stored
   is never written again). A review the browser read: `id` = `web_` + sha256(host, text, date), the text as
   extracted. A review a model relayed (`bedrock_web_search`, `agentcore_web_search`) is known by stable fields
   instead, because the model's "verbatim" text varies between reads (the same review came back 21 characters
   longer): `id` = `web_` + sha256(host, the target page's path, date, author, title), the author and title
   normalized (plain text, case-folded, every run of whitespace and punctuation one space), when it has either;
   else sha256(host, path, date, the first 200 characters of its text normalized the same way). A run queues a
   model-relayed review once: a second copy with the same id is dropped (`web_items.relayed_review_key`; 7.44.01;
   browser ids are unchanged). `created_at` is the review's date (else the import time), `url` the page it was
   read on, `channel` the target's name, `author` / `title` when the page has them, `metadata` = the target name,
   page number and `method_used` (the step that read it: `browser`, `bedrock_web_search` or `agentcore_web_search`).
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

## Methods

A target's `method` says how its page is read: `auto` (the default for a new page and for one saved without a
method), `browser` or `bedrock_web_search`. A stored `browser` or `bedrock_web_search` is kept as chosen.

| Method | What reads the page | Pages per run | What it is for |
|---|---|---|---|
| `auto` (default, **Automatic (recommended)**) | The signed browser; when it is blocked or reads no review, Amazon Bedrock web search; when that gets nothing, AgentCore Web Search's snippets | up to `max_pages` in the browser; 1 otherwise | Every page: it picks the step that reads the site, and learns it ([Learning which method works](#learning-which-method-works)) |
| `browser` (**Browser only**) | The deployment's AgentCore browser, page by page ([How a run works](#how-a-run-works)) | up to `max_pages` | A site the browser reads; the only method that follows the next pages and backfills |
| `bedrock_web_search` (**Bedrock web index only**) | An OpenAI GPT model on the Amazon Bedrock Responses API, opening the page from the Amazon Bedrock web search cache | 1 (the target's own URL) | A site that blocks the browser but whose page is in the Bedrock web index |

**`auto`** (`plugins/web_reviews/ingestor/handler.py`, `cascade.py`), per target per run, in the order the
workspace's learned record gives (with none: the steps below in this order):

1. **The signed browser** ([How a run works](#how-a-run-works)), its reviews' `method_used` `browser`. It hands the
   page to the next step when it is **blocked** (any vendor [Blocked sites](#blocked-sites) detects, an HTTP 4xx/5xx
   main document, or a redirect to an error page such as Chrome's `chrome-error://chromewebdata/`), when the page
   **did not load**, or when it reads **no review on a page that has some**: a fresh read of page 1 (not one skipped
   as unchanged, nor a backfill) extracted none while the page's JSON-LD declares a review count above 0, the target
   read reviews before, the site's record has a success, or the target was never read. A page that held reviews,
   none of them new, is read (nothing to fall back for). A redirect to another site's page ends the read, as for a
   `browser` target, with no later step.
2. **Amazon Bedrock web search**, exactly as `bedrock_web_search` below (the web search surface's model with its
   fallback, one request, at most 20 reviews, the same checks and attribution), its reviews' `method_used`
   `bedrock_web_search`. It hands on when the request fails, the model could not open the page, or it gives no review.
3. **AgentCore Web Search's snippets** (`snippet_reader.py`): one `InvokeWebSearch` of the AWS-managed tool
   `web-search.v1` (no model in the retrieval; SigV4 for `bedrock-agentcore` to
   `https://bedrock-agentcore.<region>.amazonaws.com/web-search/web-search.v1/invoke`), the query the page's title as
   the browser read it (else the target's name) plus "reviews", held to the page's domain (`domainFilter.include`),
   10 results. Only the results on the page itself are read: the same path on the site (any subdomain, a trailing
   slash ignored) with the same query once the page-number parameters (`page`, `p`, `pg`) are left out. A result on
   another page of the site (a comparison, an "alternatives" list, another business's listing) is someone else's
   reviews, so with none on the page the step reads nothing. The `enrichment` model (the browser path's extraction
   call) reads those snippets as data, and a review is kept only when its body is in one snippet, whitespace
   collapsed: nothing the snippets do not hold is stored. Its title is kept only when the snippet holds it, its
   rating and date only when the snippet shows them, never an author. Every such review is an **excerpt**: its
   `metadata` has `method_used` `agentcore_web_search`, `excerpt: true`, `snippet_cut` (the snippet starts or ends
   with an ellipsis, so the review may go on), `snippet` (the snippet's text, at most 1,000 characters),
   `snippet_url`, `snippet_title`, `snippet_published_date` (the result's url, title and `publishedAt`), `query`,
   `site`, `source_url` and `fetched_at`; its `url` is the result's URL. At most 20 per run. Offered in us-east-1,
   us-east-2, us-west-2, ap-southeast-2, ap-northeast-1 and eu-west-1; elsewhere the step is `not_offered`.

**The time budget.** A later step starts only with time left for it (120 s before the run's own reserve, as a page):
otherwise it is `skipped_time`, reported in the target's error, and learns nothing.

**What the run says.** The run row (`GET /sources/status?run_status=web_reviews&app_id=…`) carries `reads`, one entry
per target read: `target`, `target_id`, `method`, `method_used` (the step that read it, or none), `reviews` (sent),
`plan` (`known`, `reprobe` or `cascade`, for `auto`), `known_method` and `learned_at` (what the record knew),
`excerpt`, and `steps`: each step tried, `{method, outcome, reviews, vendor?, detail?}` with `outcome` `readable`,
`blocked` (with its `vendor`), `no_reviews`, `error` (with its `detail`), `skipped_time` or `not_offered`. The card
turns it into "Browser blocked by Cloudflare → read via Bedrock web index (11 reviews)" or "Known: Bedrock web index
(learned 15 Nov 2026) — 11 reviews". A step that hands on is no error: an `auto` target is reported in the run's
errors only when no step read it, as one line naming every step (`"<target>: no method read it (the browser: blocked
by Cloudflare; Amazon Bedrock web search: could not open the page (…); AgentCore web search: no reviews)"`).

**`bedrock_web_search`** (`plugins/web_reviews/ingestor/web_search_reader.py`): one request per target per run to
`https://bedrock-mantle.<region>.api.aws/openai/v1/responses`, SigV4-signed for `bedrock-mantle` with the Lambda's
role (no API key, `lambda/shared/mantle_responses.py`), with the web search surface's model and the `web_search` tool
set to
the cache only (`external_web_access: false`, `search_context_size: low`) and held to the target's site
(`filters.allowed_domains`, the host without `www.`). The model is asked for the page's reviews only, verbatim, as
JSON (author, rating, rating scale, date, title, body, and `review_kind`: `review` or `summary`), at most 20 (fewer
when `max_reviews` or the run's cap leaves fewer); a model that refuses the JSON schema is asked once more without
it.

**The model** is the `web_reviews_search` surface's, **Review pages: Bedrock web search** in Administration → AI
models (`lambda/shared/model_config.py`): its own pick there, else `openai.gpt-5.6-luna`. Its allowlist is the
OpenAI GPT family alone (`WEB_SEARCH_MODELS`: `openai.gpt-5.6-luna`, `openai.gpt-5.6-terra`, `openai.gpt-5.6-sol`,
`openai.gpt-5.5`, `openai.gpt-5.4`), which no other surface may pick; it may pick no Claude model, and the pick for
all surfaces, the deployment's default (`-c defaultModelId`) and the `e2e` profile (Claude models) do not apply to
it. The picks are the deployment's (`SETTINGS#model`), not each workspace's yet, so a run in a workspace reads the
same model. When the model cannot serve (HTTP 429 or 503, or a 400 / 403 / 404 whose answer names the model's
availability; `mantle_responses.cannot_serve`), the read is sent again to the next model of the surface's chain, like
every other surface's fallback ([deployment.md → Model Capacity
Fallback](deployment.md#model-capacity-fallback)): the resolved model, then the surface's default, then
`WEB_SEARCH_FALLBACK_ORDER` (Luna → Terra → Sol → GPT-5.5 → GPT-5.4), each model once (from Luna: Terra, Sol,
GPT-5.5, GPT-5.4; from Sol: Luna, Terra, GPT-5.5, GPT-5.4); a model that failed is tried last for 5 minutes in that
Lambda, each step is logged
and counted (`ModelFallback`, `Surface` `web_reviews_search`), and when every model fails the first one's error is
reported. Any other refusal (the role denied, the request's own shape) is reported at once. Every stored review's
`model` is the model that read it.

Before anything is queued:

- a review marked `summary`, or whose body reads like a summary of many reviews ("users find", "receives positive
  feedback", "reviewers say", …), is dropped (a page-level AI summary is one);
- the body is bounded like every path (1-5,000 characters), a rating brought to 1-5 by its own scale (an 8/10 is
  4.0) and kept only within 1-5, a date kept only as `YYYY-MM-DD`; the review is kept without a field
  that fails; a review read twice is kept once, and a near-copy (the same date, author and title, its text a
  little longer or shorter) gets the same id ([How a run works](#how-a-run-works), Items); the watermark applies as on
  the browser path;
- **attribution**: every review's `metadata` carries `method` (`bedrock_web_search`), `method_used` (the same),
  `model`, `site` (the host),
  `source_url` (the page asked for), `fetched_at` (when it was read), `opened_urls` (the URLs the model's
  `web_search` calls opened) and `cited_urls` (its `url_citation` annotations), beside `target` and `page`; the
  review's `url` is the page asked for. When no `url_citation` comes back, `source_url` and `opened_urls` are what
  attributes the review.

A refusal is reported on the target like a blocked page: `"<target>: Amazon Bedrock web search failed (HTTP 403:
…)"`, or `"… could not open the page (<reason>)"` when the model says it could not.

Limits: it is Amazon's cached copy of the page, which may be older than the live one, and no cache age is
returned; the model decides whether it opens the page (a denial or a cache miss may still answer HTTP 200 with
nothing), and what a page's cache holds differs per site (a cached page may show no author, rating or date, or
ratings on another scale); the model reads the page, so a page's own text could steer it, and the checks above are what
holds it to review-shaped data under the target's source; only the target's page is read, never the next ones;
Web Search is offered in us-east-1, us-east-2 and us-west-2 only.

**Acceptable use.** The Amazon Bedrock Web Search terms: "You must retain and display the source citations and
links provided in model outputs in any output you surface to your end users. You may not use Web Search to (a)
extract, store, or reproduce content from Search Results in bulk, or (b) build or populate a competing index or
database." So the method reads only the review pages an administrator configured, one page per target per run, at
most 20 reviews each, and every stored review keeps its source URL, method and the URLs the model opened and cited.
AgentCore Web Search has the same acceptable use ([Search the web using Amazon Bedrock AgentCore Web
Search](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/web-search-api.html)): `auto` runs it only
for a configured page the other steps could not read, once per run, at most 20 excerpts, each with its result's URL
and title.
Whether storing those reviews fits your use is your decision; OpenAI's models are also under the OpenAI Services
Agreement for Amazon Bedrock. See [Amazon Bedrock Web Search](https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html).

Prerequisites: the OpenAI models are sold through AWS Marketplace, so the account needs each model's agreement
(EULA + Marketplace subscription). While the plugin is enabled, the deploy accepts the offer of every model of the
surface in the app's region, best effort like the Claude models' ([deployment.md → Model
agreements](deployment.md#model-agreements-every-deploy-in-the-app-region-best-effort)): `VocCoreStack`'s
`WebSearchModelAgreement0`-`4`. A refused one does not fail the deploy; the surface's **Test** button answers
**No access** for it, and `-c modelAgreementRetry=<new value>` tries again. An account may hold the agreements of
only some of the five (`aws bedrock get-foundation-model-availability` answers `NOT_AVAILABLE` for a model until a
deploy accepts its offer).

## Learning which method works

Each workspace learns, from its own runs only, which method reads each review site, so an `auto` page goes straight
to what works (`lambda/shared/web_review_methods.py`). A workspace starts with nothing: no record is shared between
workspaces, and nothing is seeded (no eval result, no static hint); a deployment-wide run (no workspace) keeps its
own records the same way.

- **The record**, one per site, in voc-aggregates: `WS#{ws}#WEB_REVIEWS#METHODS` / `{domain}` (a run in a
  workspace, through its `ws_table` view), or `WEB_REVIEWS#METHODS` / `{domain}` deployment-wide. `domain` is the
  page's host, lower-cased, without `www.`, so two pages of one site share it. It holds no review and no page
  content: `best_method` (`browser`, `bedrock_web_search`, `agentcore_web_search`, or `none`), `learned_at`, and
  per step tried `last_outcome` (`readable`, `blocked:<vendor>`, `no_reviews`, `error`), `last_at`, `successes`,
  `failures` and `last_reviews`. Only `auto` targets read and write it.
- **The plan** of a run, in this order of precedence (a step blocked within **7 days** is always left out):
  - a record whose best step read the site within **30 days**: that step first (`known`), and when it fails now the
    cascade continues from the top;
  - the same, when the best step is not the browser and the browser was last tried more than **14 days** ago (or
    never): the browser first, once (`reprobe`, "Re-checked the browser: still blocked by Cloudflare → Bedrock web
    index"), so a site that lets the browser in again is not read the worse way forever;
  - no record, or a best step that is stale or `none`: the whole cascade (`cascade`).
  Each plan is logged with its order, the known best, when it was learned and what it left out.
- **What a run teaches**: each step that ran adds its outcome; the first that read reviews is the new best (its time
  `learned_at`); when the known best fails now and nothing else reads the site, the best is `none`, so the next run
  tries the whole cascade; a step skipped for time changes nothing. The ingestor puts the whole record after each
  target (of two runs at once, the last write wins); a record that cannot be read or written is logged and the run
  goes on. IAM: the ingestor's existing voc-aggregates grant (every ingestor role's Put / Update and reads), its
  workspace view refusing any key outside the run's workspace.
- **Seeing and clearing it**: `GET /integrations/web_reviews/methods` (any member; the Data sources card's "Known
  best" line) and `GET /scrapers/review-methods` (the same answer, for the AI assistant's `list_review_site_methods`:
  the stream invokes the scrapers API) list the request's workspace's records, each with `browser_recheck_due_at`.
  **Re-check methods** on a card, `DELETE /integrations/web_reviews/methods/{domain}`, clears that workspace's record
  of the site only (its admins; without `X-Workspace-Id` the deployment's admins and the deployment's record), so the
  next run tries the whole cascade; in a workspace it is audited first in `AUDIT#WS#{ws}` (kind
  `web_review_methods_cleared`, the actor's sub, the site). Its IAM: `dynamodb:DeleteItem` on those two partitions
  only (`dynamodb:LeadingKeys`), while the plugin is enabled.
- **Export and delete**: a workspace's hard delete sweeps its records (`web_review_methods`); its export leaves them
  out (operational: its runs learn them again).

## Blocked sites

Some sites refuse automated browsers from cloud addresses. A blocked page is **reported, never read as empty**:
the run completes with an error per target, `"<target>: blocked by <vendor>"`, shown on the card. Detected:
DataDome, HUMAN (PerimeterX, "press & hold"), Cloudflare challenges and hard blocks ("Sorry, you have been
blocked"), AWS WAF challenges (its `awswaf.com` challenge script on a short page), Reddit's network-security and
network-policy pages, CAPTCHAs, an HTTP 4xx/5xx main document, and a short "access denied" page.

From AWS addresses an unsigned browser is often refused by bot management (DataDome, HUMAN, Cloudflare) and by
sites that require a login; Web Bot Auth (below) lets a site that supports it recognise the signed browser, and a
site may still refuse signed agents. `auto` then reads such a page from the Bedrock web index or AgentCore Web
Search. Some sites allow their reviews through their official APIs only (Yelp: the Yelp Fusion API; Reddit: the
Reddit Data API); add those sources with their APIs, not as review pages. Respect each site's terms of use when you
add it.

**Web Bot Auth** (since 7.41.00, on by default). The ingestor's browser is the deployment's own custom AgentCore
browser (`voc_web_reviews`, `<prefix>_voc_web_reviews` under a deployment prefix) created with browser signing on:
AgentCore signs every HTTP request it makes with the draft IETF Web Bot Auth protocol (the `Signature`,
`Signature-Agent` and `Signature-Input` headers), so a bot control vendor that supports it (Cloudflare, HUMAN
Security, Akamai, DataDome, F5) can verify that the request comes from Amazon Bedrock AgentCore. It does not
bypass anything: the site owner decides whether verified agents are allowed, rate-limited or blocked, and a site
whose bot control does not support Web Bot Auth sees no difference. The feature is in **Preview** (its protocol and
parameters may change). See [Reducing CAPTCHAs with Web Bot Auth](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-web-bot-auth.html).
`-c webReviewsBotAuth=false` keeps the AWS-managed `aws.browser.v1`, which does not sign, as before 7.41.00
([deployment.md](deployment.md#deploy-options-reference)); either way changes nothing stored.

### Honesty rules

The plugin identifies itself and lets each site's bot control decide. It never masks `navigator.webdriver`, removes
automation flags, spoofs a fingerprint or a person's User-Agent, solves CAPTCHAs, or rotates IPs or proxies to get
past a block. Web Bot Auth is the sanctioned way to be recognised; a site that still refuses is reported as
blocked.

## Sessions and profiles

- **One session per run**, shared by every browser target of the run (a run of `bedrock_web_search` targets only
  starts none). Its timeout is the Lambda's remaining time, so it needs no keep-alive. When its connection closes
  mid-run, ONE new session continues with the target that was being read (read again from its start) and the ones
  after it; a second close, or no time left for a page, is reported as `"The browser session failed: …"` and keeps
  what was already read.
- **A navigation is tried once more** (after 2 s, in the same tab and session) when it fails on the network
  (`net::ERR_CONNECTION_RESET`, `…_CLOSED`, `…_TIMED_OUT`, `net::ERR_TIMED_OUT`, `net::ERR_EMPTY_RESPONSE`,
  `net::ERR_NETWORK_CHANGED`, `net::ERR_HTTP2_PROTOCOL_ERROR`) or the browser does not answer it in time; a second
  failure is the page's error. A site that does not exist is not tried again.
- **A browser profile** (`AWS::BedrockAgentCore::BrowserProfile`, `voc_web_reviews`, on by default): each run's
  session starts from it and is saved into it (`SaveBrowserSessionProfile`) before it is stopped, so the review
  sites' cookies and local storage (consent, the sites' own tokens) carry over to the next run. It is one per
  deployment, shared by every workspace's runs: the plugin reads public pages only and never signs in, so a
  profile holds no workspace's data; runs at the same time each save, and the last save wins. A failed save is
  logged and the run goes on. A Lambda runtime whose boto3 does not know profiles starts the session without one.
  `-c webReviewsBrowserProfile=false` keeps no profile: every run starts with no cookies.
- Not done, on purpose or until measured: blocking images, media or fonts (it changes what the site sees and can
  raise blocks; the browser's HTTP cache is on, and pages 2..N are in-page fetches that use it), clicking "load
  more" buttons, and an early end of the settle wait when the page's JSON-LD already holds reviews (the wait is
  already readiness-based: `document.readyState` and a text length that stops changing, 3 s at least, 25 s at
  most).

## Evaluating sites

`voc-datalake/scripts/evals/web_reviews_sites.py` reads page 1 of each site in a curated list
(`voc-datalake/plugins/web_reviews/evals/sites.json`: about 27 public review pages across bot-protection vendors,
inputs only: each page's URL, its subject, what is documented of it (`expect`: `unknown`, or `login` for a site that
asks signed-out visitors to sign in, or `official_api_only`), and its documented feeds or official APIs) by every
method and writes a comparison. It reuses the ingestor's own code and writes nothing to the deployment: no queue, no
watermark, no learned method record, no secret, no profile save.

| Method | What it does |
|---|---|
| `signed` | The deployment's Web Bot Auth browser (its id read from the deployed ingestor's `BROWSER_IDENTIFIER`) |
| `unsigned` | The AWS-managed `aws.browser.v1` |
| `http` | A direct fetch with an honest User-Agent (`VoC-Analytics-ReviewReader/<version> (+<this page>)`), robots.txt honoured (`robots_disallowed`) |
| `feed` | A site's documented structured source, where it has one that needs no secret (RSS/Atom, a public JSON endpoint); an official API that needs a key is listed, not run |
| `bedrock_web_search:<model>` | The ingestor's `bedrock_web_search` reader, with `openai.gpt-5.6-luna` and `openai.gpt-5.6-terra`; its reviews' bodies are checked against the page text another method read (`verbatim`, `partial`, `paraphrase_risk`, `unverifiable`) |
| `agentcore_web_search` | The ingestor's snippet step (`InvokeWebSearch`, `"<subject> reviews"` held to the site's domain, 10 results, only the results on the page itself read; a review kept only when its body is in one snippet, `excerpt_only` when that snippet is a cut passage); `not_run` in a region the API is not offered in |
| `auto` | What `auto` picks on a first run (no learned record): `signed`, then `bedrock_web_search` with the first model, then `agentcore_web_search`, each next step only when the one before got nothing; it reuses this run's rows of those methods (it always runs last) and runs a missing step itself; its row names the step that read the site (`picked`) and the chain |

A site marked `official_api_only` (Yelp, Reddit: the site allows its reviews through its official API only) is read
by no method: each method's row says `official_api_only`, with the API's documentation.

Per site and method it reports the outcome (`readable`, `blocked:<vendor>`, `login`, `robots_disallowed`,
`off_host`, `no_reviews`, `unextracted`, `error`, `not_run`, `official_api_only`), the reviews on page 1, pages
read, seconds, the extraction (`json-ld`, `model`, `text`, `feed`, `json`, `web_search`, `snippets`, or `auto`'s
picked step) and how it compares with the expectation, as a JSON and a Markdown report: a table, and a site × method
grid with the bot-management vendors this run met on each site. Run it from `voc-datalake/` with the deployment's
credentials (`--dry-run` first: it prints what it would do and calls nothing):

```bash
AWS_PROFILE=<profile> .venv/bin/python scripts/evals/web_reviews_sites.py --region us-west-2 --prefix <prefix> --dry-run
AWS_PROFILE=<profile> .venv/bin/python scripts/evals/web_reviews_sites.py --region us-west-2 --prefix <prefix>
```

The reports are written locally only, under `voc-datalake/web-reviews-eval/<UTC time>/` (git-ignored; `--out` may
name another directory inside `web-reviews-eval/` and nowhere else), and are never committed: no run's results are
kept in the repository, its docs or its test fixtures. `--only g2,capterra` reads some sites, `--methods
signed,unsigned` some methods, `--no-model` skips every model call (JSON-LD only), `--model-calls N` (1 by default)
caps the extraction calls per page, `--web-search-models` changes the two web search models and `--browser-id` names
the signed browser instead of reading it from the deployed ingestor. It runs with the operator's credentials: the
browser sessions run in AgentCore exactly as the ingestor's do (from AWS addresses, signed or not), while the HTTP
and feed requests reach the sites from the operator's machine (so their outcome is that address's, not a Lambda's;
and the URL policy resolves each host with the operator's DNS, so a resolver that cannot answer for a host makes
that site's rows `error`). Its cost, at most: two browser sessions per site (300 s timeout each, a few seconds used),
one extraction model call per page without JSON-LD, two Responses requests per site and one web search (plus one
model call over its snippets); `auto` adds nothing when the other methods ran.

## Cost

Each run starts one browser session (when it has a browser target) and, for pages without JSON-LD, makes one model
call per 40,000 characters of page text (at most four per page); a page unchanged since the last run makes none.
Nothing costs anything while idle: the custom browser and its role are free, sessions bill per second of CPU and
memory as on `aws.browser.v1`, and the browser profile is stored at Amazon S3 Standard rates (kilobytes). A
`bedrock_web_search` target costs one Responses request per run: the model's tokens (the opened page counts as
input) plus Web Search's tool calls. An `auto` target costs only the steps it runs: the browser's, and a Bedrock web
search request and an AgentCore Web Search request (plus one `enrichment` model call over its snippets) only when the
steps before them got nothing; a site the workspace learned is read by its best step alone. See
[Amazon Bedrock AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) for browser session time
and [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) for the model calls and Web Search
(AgentCore Web Search is on the AgentCore pricing page).

## Infrastructure and regions

- Lambda `voc-ingestor-web_reviews` (VocIngestionStack, Python 3.15, ARM64, 900 s, 512 MB). Its schedule rule
  (`rate(15 minutes)`) is created **disabled**; each target's `frequency_minutes` decides whether a scheduled
  tick reads it.
- The browser (VocIngestionStack, made only while a plugin with `infrastructure.ingestor.browser: true` is
  enabled; `lib/stacks/ingestion-browser.ts`): `AWS::BedrockAgentCore::BrowserCustom` `voc_web_reviews` (public
  network, browser signing on; `<prefix>_voc_web_reviews` under `-c deploymentPrefix`) and its execution role
  (trusted by `bedrock-agentcore.amazonaws.com` with `aws:SourceAccount` the account and `aws:SourceArn`
  `arn:aws:bedrock-agentcore:<region>:<account>:*`; no policy: signing needs no permission), and
  `AWS::BedrockAgentCore::BrowserProfile` `voc_web_reviews`. The ingestor is told them in `BROWSER_IDENTIFIER`
  and `BROWSER_PROFILE_IDENTIFIER` (each unset when its resource is not made: `aws.browser.v1`, no profile). The
  browser's name, description, network and signing are create-only: changing one replaces the browser, which
  holds no data. With `-c webReviewsBotAuth=false -c webReviewsBrowserProfile=false` the browser is as in
  7.40.00 (`aws.browser.v1`, no resource of the deployment's, no browser variable); the role still carries the
  web search grants below.
- IAM (dedicated role, manifest `infrastructure.ingestor.browser: true`): `bedrock-agentcore:StartBrowserSession`,
  `StopBrowserSession` and `SaveBrowserSessionProfile` on the deployment's browser only
  (`arn:aws:bedrock-agentcore:<region>:<account>:browser-custom/<id>`, or `…:aws:browser/aws.browser.v1` when
  opted out); `StartBrowserSession` and `SaveBrowserSessionProfile` on its profile only; and
  `bedrock-agentcore:ConnectBrowserAutomationStream` on `*`, because the service authorization reference lists
  no resource type for it (the IAM policy simulator denies it on the browser ARN). With
  `infrastructure.ingestor.webSearch: true` (the `bedrock_web_search` method): `bedrock-mantle:CreateInference`
  on `arn:aws:bedrock-mantle:<region>:<account>:project/default` (the GPT allowlist is enforced in code: the value
  format of the `bedrock-mantle:Model` condition key is not documented) and `bedrock-websearch:InvokeSearch` /
  `InvokeFetch` on `*` held to the region (`aws:RequestedRegion`), as the Web Search IAM guide grants them; never
  `bedrock-websearch:ExternalWebAccess`; and, for `auto`'s last step, `bedrock-agentcore:InvokeWebSearch` on the
  region's AWS-managed tool only, `arn:aws:bedrock-agentcore:<region>:aws:tool/web-search.v1` (the AgentCore
  developer guide's grant: the account field is the literal `aws`). Plus the Bedrock model grant of `bedrock: true`. The settings Lambda's
  Test of the surface (`lambda/shared/web_search_model_probe.py`: one request, no tool) holds only
  `bedrock-mantle:CreateInference` on the same project, and only while the plugin is enabled. voc-design-capture
  reuses the browser module without either variable: it stays on `aws.browser.v1`, without a profile.
- Dependency: `websocket-client==1.9.2` (Apache-2.0) in the `ingestion-deps` layer.
- AgentCore Browser is part of AgentCore Built-in Tools, available in the US, EU (including Frankfurt,
  eu-central-1) and Asia Pacific regions listed on the
  [AgentCore regions page](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html).
  The session runs in the Lambda's region. Where it is not available the run reports
  "AgentCore Browser is unavailable in <region>".
