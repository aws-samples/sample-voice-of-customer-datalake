# Web reviews (generic review-page plugin)

The `web_reviews` plugin reads customer reviews from **public review pages**, such as a company page on a review
site, a travel listing or a forum, with a managed browser (or, for a page you choose, from the Amazon Bedrock web
search index: [Methods](#methods)). It imports them through the normal pipeline (source
policy, raw archive, processing queue). It is site-agnostic: nothing in it knows a particular site. Administrators
add pages; every page becomes its own source.

It is **on by default** (`pluginStatus.web_reviews: true` in `voc-datalake/cdk.context.json`) and does nothing
until an administrator adds a page.

## Adding pages

- **Data sources** (`/scrapers`) → **New source** → **A website link** → **Review page**: add a page with a name,
  its `https` URL, how to read it (`method`, the browser by default; [Methods](#methods)), how much to read (pages
  per run, 0-100, default 10; reviews per run, 0-5,000, default 0; see [Reading modes](#reading-modes)) and a run
  frequency (manual only by default). Each page is listed under
  **Review pages** with Run now, Edit, Delete and the last run's status.
- **AI assistant** (administrators): `create_app_connector` with `source: "web_reviews"`, `url` and optionally
  `max_pages` / `max_reviews`, approved on a card. In plan mode the assistant can find review pages with web search
  (`plan_lookup`), list each chosen URL as its own write on the plan card, then `run_source web_reviews` and wait
  for the run ([assistant-plan-mode.md](assistant-plan-mode.md)). It proposes only a URL copied from a web search
  result that names the company (one search per site), never a URL built from a name, and says when a site has no
  page for it ([scrapers.md → With the AI assistant](scrapers.md#with-the-ai-assistant-administrators)).
- **API**: `POST /integrations/web_reviews/apps` with `{"app": {"app_name", "url", "max_pages"?,
  "max_reviews"?, "frequency_minutes"?, "enabled"?, "method"?, "model"?}}` (admin). The target is validated before it is saved
  (`lambda/shared/web_review_targets.py`): https only, the host must resolve to public addresses only (the shared
  outbound URL policy / SSRF guard), `max_pages` 0-100, `max_reviews` 0-5000 (both stored as strings),
  `frequency_minutes` one of 0, 15, 30, 60, 180, 360, 720,
  1440; `method` `browser` (the default; absent means `browser`) or `bedrock_web_search` (anything else is a 400
  naming the two); `model` only for `bedrock_web_search`, one of `openai.gpt-5.6-luna` (the default),
  `openai.gpt-5.6-terra`, `openai.gpt-5.6-sol`, `openai.gpt-5.5`, `openai.gpt-5.4` (dropped for a browser
  target); unknown fields are dropped. Targets are stored like the app connectors, as `web_reviews_configs` in the
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
   browser, and a run of those only starts no session.
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

## Methods

A target's `method` says how its page is read. Existing targets, and a new one that names none, use the browser.

| Method | What reads the page | Pages per run | What it is for |
|---|---|---|---|
| `browser` (default) | The deployment's AgentCore browser, page by page ([How a run works](#how-a-run-works)) | up to `max_pages` | Every site the browser may read; the only method that follows the next pages and backfills |
| `bedrock_web_search` (an explicit choice) | An OpenAI GPT model on the Amazon Bedrock Responses API, opening the page from the Amazon Bedrock web search cache | 1 (the target's own URL) | A site that blocks the browser but whose page is in the Bedrock web index (measured 2026-11-15 on gartner.com, trustradius.com, capterra.com and g2.com) |

**`bedrock_web_search`** (`plugins/web_reviews/ingestor/web_search_reader.py`): one request per target per run to
`https://bedrock-mantle.<region>.api.aws/openai/v1/responses`, SigV4-signed for `bedrock-mantle` with the Lambda's
role (no API key), with the target's `model` (`openai.gpt-5.6-luna` by default) and the `web_search` tool set to
the cache only (`external_web_access: false`, `search_context_size: low`) and held to the target's site
(`filters.allowed_domains`, the host without `www.`). The model is asked for the page's reviews only, verbatim, as
JSON (author, rating, rating scale, date, title, body, and `review_kind`: `review` or `summary`), at most 20 (fewer
when `max_reviews` or the run's cap leaves fewer); a model that refuses the JSON schema is asked once more without
it. Before anything is queued:

- a review marked `summary`, or whose body reads like a summary of many reviews ("users find", "receives positive
  feedback", "reviewers say", …), is dropped (Capterra's page-level AI summary is one);
- the body is bounded like every path (1-5,000 characters), a rating brought to 1-5 by its own scale (a TrustRadius
  8/10 is 4.0) and kept only within 1-5, a date kept only as `YYYY-MM-DD`; the review is kept without a field
  that fails; a review read twice is kept once; the watermark applies as on the browser path;
- **attribution**: every review's `metadata` carries `method` (`bedrock_web_search`), `model`, `site` (the host),
  `source_url` (the page asked for), `fetched_at` (when it was read), `opened_urls` (the URLs the model's
  `web_search` calls opened) and `cited_urls` (its `url_citation` annotations), beside `target` and `page`; the
  review's `url` is the page asked for. On the 2026-11-15 runs no `url_citation` came back, so `source_url` and
  `opened_urls` are what attributes the review.

A refusal is reported on the target like a blocked page: `"<target>: Amazon Bedrock web search failed (HTTP 403:
…)"`, or `"… could not open the page (<reason>)"` when the model says it could not.

Limits: it is Amazon's cached copy of the page, which may be older than the live one, and no cache age is
returned; the model decides whether it opens the page (a denial or a cache miss may still answer HTTP 200 with
nothing), and what a page's cache holds differs per site (G2's had no author, rating or date; TrustRadius's had
ratings out of 10); the model reads the page, so a page's own text could steer it, and the checks above are what
holds it to review-shaped data under the target's source; only the target's page is read, never the next ones;
Web Search is offered in us-east-1, us-east-2 and us-west-2 only.

**Acceptable use.** The Amazon Bedrock Web Search terms: "You must retain and display the source citations and
links provided in model outputs in any output you surface to your end users. You may not use Web Search to (a)
extract, store, or reproduce content from Search Results in bulk, or (b) build or populate a competing index or
database." So the method reads only the review pages an administrator configured, one page per target per run, at
most 20 reviews each, and every stored review keeps its source URL, method and the URLs the model opened and cited.
Whether storing those reviews fits your use is your decision; OpenAI's models are also under the OpenAI Services
Agreement for Amazon Bedrock. See [Amazon Bedrock Web Search](https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html).

Prerequisites: the OpenAI models are sold through AWS Marketplace, so the account needs the model's subscription
before a target may use it (an administrator accepts the offer once, for example in the Amazon Bedrock console; the
deployment never accepts one). On 2026-11-15 the test account had `openai.gpt-5.6-terra`'s agreement in place.

## Blocked sites

Some sites refuse automated browsers from cloud addresses. A blocked page is **reported, never read as empty**:
the run completes with an error per target, `"<target>: blocked by <vendor>"`, shown on the card. Detected:
DataDome, HUMAN (PerimeterX, "press & hold"), Cloudflare challenges and hard blocks ("Sorry, you have been
blocked"), AWS WAF challenges (its `awswaf.com` challenge script on a short page), Reddit's network-security and
network-policy pages, CAPTCHAs, an HTTP 4xx/5xx main document, and a short "access denied" page.

In testing from AWS on the unsigned `aws.browser.v1`, review sites that publish JSON-LD review markup were readable
(about 20 reviews per page), while sites behind DataDome or HUMAN bot protection, or that require a login, were
blocked; on 2026-11-15 g2.com was blocked by DataDome and gartner.com, trustradius.com and capterra.com by
Cloudflare. Respect each site's terms of use when you add it.

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
each with the vendor seen in its response headers, the expectation and the outcome measured earlier on the unsigned
browser, and the evidence for each) by every method and writes a comparison. It reuses the ingestor's own code and
writes nothing to the deployment: no queue, no watermark, no secret, no profile save.

| Method | What it does |
|---|---|
| `signed` | The deployment's Web Bot Auth browser (its id read from the deployed ingestor's `BROWSER_IDENTIFIER`) |
| `unsigned` | The AWS-managed `aws.browser.v1` (the baseline) |
| `http` | A direct fetch with an honest User-Agent (`VoC-Analytics-ReviewReader/<version> (+<this page>)`), robots.txt honoured (`robots_disallowed`) |
| `feed` | A site's documented structured source, where it has one that needs no secret (RSS/Atom, a public JSON endpoint); an official API that needs a key is listed, not run |
| `bedrock_web_search:<model>` | The ingestor's `bedrock_web_search` reader, with `openai.gpt-5.6-luna` and `openai.gpt-5.6-terra`; its reviews' bodies are checked against the page text another method read (`verbatim`, `partial`, `paraphrase_risk`, `unverifiable`) |
| `agentcore_web_search` | The AgentCore Web Search API (`InvokeWebSearch`, SigV4 for `bedrock-agentcore`, `"<subject> reviews"` held to the site's domain, 10 results); the extraction model reads the snippets only, and a review is kept only when its body is in one snippet (`excerpt_only` when that snippet is a cut passage); `not_run` in a region the API is not listed for |

Per site and method it reports the outcome (`readable`, `blocked:<vendor>`, `login`, `robots_disallowed`,
`off_host`, `no_reviews`, `unextracted`, `error`, `not_run`), the reviews on page 1, pages read, seconds, the
extraction (`json-ld`, `model`, `text`, `feed`, `json`, `web_search`) and how it compares with the expectation and
with the unsigned baseline, as a JSON and a Markdown report in the `--out` directory (a table and a site × method grid). Run it from
`voc-datalake/` with the deployment's credentials (`--dry-run` first: it prints what it would do and calls
nothing):

```bash
AWS_PROFILE=<profile> .venv/bin/python scripts/evals/web_reviews_sites.py --region us-west-2 --prefix <prefix> --dry-run
AWS_PROFILE=<profile> .venv/bin/python scripts/evals/web_reviews_sites.py --region us-west-2 --prefix <prefix>
```

The report goes to `web-reviews-eval/<UTC time>/` (ignored by git; `--out` to change it). `--only g2,capterra` reads
some sites, `--methods signed,unsigned` some methods, `--no-model` skips every model call (JSON-LD only),
`--model-calls N` (1 by default) caps the extraction calls per page, `--web-search-models` changes the two web
search models and `--browser-id` names the signed browser instead of reading it from the deployed ingestor. It runs
with the operator's credentials: the browser sessions run in AgentCore exactly as the ingestor's do (from AWS
addresses, signed or not), while the HTTP and feed requests reach the sites from the operator's machine (so their
outcome is that address's, not a Lambda's). Its cost, at
most: two browser sessions per site (300 s timeout each, a few seconds used), one extraction model call per page
without JSON-LD, two Responses requests per site and one web search (plus one model call over its snippets).

### Latest results

Not run yet against a deployment with Web Bot Auth: the table is filled from the eval's Markdown report after the first run.

| Site | Vendor | signed | unsigned | http | bedrock_web_search (luna / terra) |
|---|---|---|---|---|---|
| … | … | … | … | … | … |

## Cost

Each run starts one browser session (when it has a browser target) and, for pages without JSON-LD, makes one model
call per 40,000 characters of page text (at most four per page); a page unchanged since the last run makes none.
Nothing costs anything while idle: the custom browser and its role are free, sessions bill per second of CPU and
memory as on `aws.browser.v1`, and the browser profile is stored at Amazon S3 Standard rates (kilobytes). A
`bedrock_web_search` target costs one Responses request per run: the model's tokens (the opened page counts as
input) plus Web Search's tool calls ($12 per 1,000 calls in the US regions on 2026-11-15). See
[Amazon Bedrock AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) for browser session time
and [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) for the model calls and Web Search.

## Infrastructure and regions

- Lambda `voc-ingestor-web_reviews` (VocIngestionStack, Python 3.14, ARM64, 900 s, 512 MB). Its schedule rule
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
  `bedrock-websearch:ExternalWebAccess`. Plus the Bedrock model grant of `bedrock: true`. voc-design-capture
  reuses the browser module without either variable: it stays on `aws.browser.v1`, without a profile.
- Dependency: `websocket-client==1.9.2` (Apache-2.0) in the `ingestion-deps` layer.
- AgentCore Browser is part of AgentCore Built-in Tools, available in the US, EU (including Frankfurt,
  eu-central-1) and Asia Pacific regions listed on the
  [AgentCore regions page](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html).
  The session runs in the Lambda's region. Where it is not available the run reports
  "AgentCore Browser is unavailable in <region>".
