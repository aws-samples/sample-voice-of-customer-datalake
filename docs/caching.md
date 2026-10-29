# Read caching

When no new reviews arrive, the dashboards ask the same questions again and again.
The API now remembers its answers and works out whether they are still current,
without any cache service to pay for. There is no API Gateway cache cluster,
ElastiCache or DAX: everything is pay-per-use DynamoDB plus Lambda memory.

There are three layers:

| Layer | Where | What it saves | Lifetime |
|---|---|---|---|
| Version counters | `voc-aggregates` / `voc-radar` rows | — (tells the other two layers whether anything changed) | permanent, only ever incremented |
| Warm-container memo | Lambda memory (`lambda/shared/response_cache.py`) | the route's DynamoDB reads and CPU | at most 10 min, LRU of about 200 answers / 5 MB per container |
| HTTP revalidation | `ETag` / `If-None-Match` (`lambda/shared/http_cache.py`) | the response body on the wire, plus the browser's JSON parse | the browser keeps it, but must check it on every use |

## 1. Version counters (`lambda/shared/data_version.py`)

| Row | Covers | Bumped by (once per batch or request, never per record) |
|---|---|---|
| `voc-aggregates` `METRIC#meta / data_version` | feedback data | the aggregator, once per DynamoDB Streams batch that carried a feedback write; the category-reprocess worker at each page checkpoint and when an invocation ends (completion, hand-over, cancel, failure); `voc-retention` after a run that deleted something; `PUT /feedback/{id}/category`, `PUT /feedback/{id}/dimensions` and `PUT /data-explorer/feedback`, so a person sees their own correction straight away instead of after the stream catches up |
| `voc-aggregates` `METRIC#meta / config_version` | settings that change what reads return | `PUT /settings/categories`, `/settings/brand`, `/settings/sources`, `/settings/dimensions` (also the inbox's "add feedback type" dimension), `/settings/model`, `PUT /users/{u}/category-access` |
| `voc-radar` `SETTINGS#radar / version` | Radar data | the processor, once per SQS batch that stored a Radar review; the Radar scan when it records its outcome (after it has filed the releases); `PUT /radar/brands`, `PUT /radar/settings` |

Each row holds `v` (incremented with `ADD`) and `updated_at`. A bump never fails the
write it follows: if it fails, the error is logged and cached answers fall back on
their 10-minute maximum age.

Reads take one strongly consistent `BatchGetItem`. It fetches `data_version`,
`config_version` and the earliest-data watermark (`METRIC#meta / earliest_date`)
together, plus the Radar counter on Radar routes. That replaces the single
watermark `get_item` the metrics routes already made, so a request still costs one
round trip. If the version read fails, or comes back incomplete or malformed, that
request is served live (no memo) and the watermark falls back to a plain `get_item`.

## 2. Warm-container memo (`lambda/shared/response_cache.py`)

Routes opt in with `@memoized_route`:

- **metrics**: `/metrics/summary|sentiment|categories|sources|personas|dimensions|github`,
  `/feedback`, `/feedback/urgent`, `/feedback/search` and `/feedback/entities`,
  including paged requests (the cursor is part of the query).
- **Radar**: `GET /radar`, `/radar/brands`, `/radar/brands/{b}`, `/releases`, `/compare` and `/reviews`.

The cache key is the route, the path, the normalized query string, today's UTC date,
the caller's scope fingerprint and the versions (with the watermark). The resolved
`days` window follows from the query, the watermark and the date. The scope
fingerprint is a SHA-256 of the full category and source rule plus the admin and
delegated flags. **The scope is resolved on every request before the memo is
consulted**, so a change to someone's access applies on their next request, and two
callers with different scopes never share an answer.

The memo never stores:

- an answer that reports a partial read (`is_partial`, `is_partial_window` or a `partial_reason`);
- `success: false`, an error, or a non-200 `Response`;
- anything that is not a JSON object;
- an answer when the version read failed.

Hits are deep copies, so later framework steps cannot change a stored entry.

**Settings reads are deliberately not memoized.** Each public settings GET
(`/settings/brand`, `/categories`, `/dimensions`, `/sources`, `/model`) is a single
`GetItem`. Checking freshness would cost the same read, so there is nothing to save
(the default followed: do not add a cache whose check costs as much as a miss). They
still get the HTTP revalidation below, and their saves bump `config_version`, which
the metrics and Radar entries depend on.

### Freshness by data class

| Data class | Becomes stale when | Then |
|---|---|---|
| Feedback metrics and lists | a stream batch, an edit, a reprocess checkpoint or a retention delete bumps `data_version` | the next request recomputes |
| Settings-dependent answers (labels, dimensions, visible categories and sources) | a settings or category-access save bumps `config_version` | the next request recomputes |
| Radar (reviews, releases, brands, scan outcome) | the processor, the scan or a Radar save bumps the Radar version (Compare also depends on `data_version`) | the next request recomputes |
| "Today" windows | the UTC date changes | a new key |
| Anything in the memo | 10 minutes old, even with no bump (a safety net for a lost bump) | evicted |

## 3. HTTP revalidation (every API Lambda, `create_api_resolver`)

- A GET that answers 200 with JSON gets `ETag: W/"<first 32 hex of SHA-256(body)>"`,
  `Cache-Control: private, no-cache` and `Vary: Authorization`. The browser may keep
  the answer but must ask again every time. If the request's `If-None-Match` matches,
  the answer is a **304 with an empty body**, still carrying the ETag and CORS headers.
  There is never a `max-age`: a browser cache is keyed by URL, not by user, and only
  the server's versions decide whether an answer is fresh.
- GETs of per-user live state get `Cache-Control: private, no-store` and no tag. That
  covers chat conversations, agent runs, plans, every `…/jobs` poll, the brief,
  reprocess, erasure, manual-import parse polls, scraper status,
  `/sources/status`, `/integrations/status`, connect tokens, memory
  import polls (`/memory/imports/{id}`), voting sessions and the system log search
  (`/logs/system`). The full list is
  `NO_STORE_PATTERNS`. Any other GET that is not a
  200 JSON answer gets `no-store` too.
- `ETag` is in `Access-Control-Expose-Headers`, both on the Lambdas' own CORS and on
  the gateway responses (`lib/stacks/api-gateway.ts`). `If-None-Match` is not in the
  allowed request headers on purpose: the browser's HTTP cache adds it when
  revalidating, and headers the cache adds itself need no preflight entry. The REST
  Lambda proxy passes a 304 through unchanged, and gateway errors (4XX/5XX) are not
  involved.

## IAM

- Only the `UpdateItem` grants the bumps need were added, each pinned by
  `dynamodb:LeadingKeys` to the version partition: feedback edit, data explorer and
  users on aggregates `METRIC#meta`, and the Radar API and Radar scan on Radar
  `SETTINGS#radar`.
- The Radar API also gained `BatchGetItem` on both tables.
- Every other writer already held `UpdateItem` (the processing role, reprocess,
  retention and settings). The metrics role already had `BatchGetItem`.
- The grants are pinned by `lib/stacks/api-stack-cache-versions.test.ts`.

## First load

The 5.34.00 live test timed first loads at about 10 s on Radar, 8.9 s on Participants and 8 s on Data
Explorer. CloudWatch REPORT lines for those loads (read-only, 7 days to 2026-10-25) put the API side at
1.6–4.5 s, nearly all of it Lambda Init: warm invocations of the three functions ran p50 11–48 ms and
p95 104–440 ms, and every first call paid an Init Duration of 1.1–1.8 s. The rest was the browser
fetching the app shell. Three causes were ours:

- **Radar asked for one brand in three parallel requests.** After `GET /radar` it called the detail,
  `/releases` and `/compare` together. A cold `voc-radar-api` serves one request per environment, so the
  third request often started a SECOND environment and paid a second Init (05:00 UTC load: 1.29 s, then
  1.42 s, one after the other). The page now reads `GET /radar/brands/{brand}/page` (the three answers in
  one, memoized like its parts). A `?brand=` link starts that read beside `/radar`, and the categories
  config and source profiles used for labels start at mount instead of after the first render.
  Pinned by `Radar.requests.test.tsx` and `test_radar_brand_page.py`.
- **The app shell imported the charts library.** `clsx` is a dependency of `recharts`, so Rollup put it
  in `vendor-recharts`. The shell uses `clsx`, so every first load fetched and ran 389 KB of charts
  (114 KB gzipped), on pages that draw none. `vendorChunks.json` (vite.config.ts) lists `clsx` beside React, and
  `vendorChunks.test.ts` fails when another shared dependency is left unlisted.
- **The floating assistant panel was in the shell.** It renders only once opened, but `AssistantRoot`
  imported it, and with it `react-markdown` (156 KB). It is now a lazy chunk. Pinned by `bootGraph.test.ts`,
  which walks the static imports from `main.tsx`.

JS fetched before any page chunk (entry plus `modulepreload`s; measured on local builds of 5.34.00 and of
this change): 1,699 KB → 937 KB (516 → 291 KB gzipped).

Not changed: Participants (one `GET /participants/lists`) and Data Explorer (the buckets and S3 listing,
in parallel) already make one round of requests. What is left for them is Init. SnapStart would cut a cold
start to a restore (p50 460–500 ms on the four SnapStart APIs, docs/lambda-sizing.md) but adds a monthly
cache charge, so it is an owner decision.

## Expected savings

- **A memo hit** costs the version read: 3 RCU (three small items read strongly
  consistently; 4 RCU on Radar). It replaces the route's own reads:
  - Item-path routes go through per-day `gsi1-by-date` walks: restricted callers,
    any source/channel/dimension/tag filter, `/feedback` lists and search, entities,
    personas. Those read roughly 100 to 2,000+ RCU per call over 7 to 30 days of
    reviews (128 RCU per 1 MB page). A hit saves about **97–99 %+** of that, cuts
    latency from hundreds of milliseconds to tens, and frees the Lambda's CPU.
  - Unrestricted routes served from the aggregates read a few RCU (one bounded
    `Query`). There a hit is roughly even with today: the strongly consistent
    version read costs 3 RCU against the old 0.5 RCU watermark read, which is the
    price of seeing your own writes straight away.
- **A miss** costs 2.5 RCU more than before, again because the version read is
  strongly consistent.
- **Hit rate.** This is an estimate, not measured: every ingestion batch bumps
  `data_version`. Between scheduled ingests, or overnight, repeated navigation (Home,
  Dashboard, Categories and back) should be answered mostly from memory by warm
  containers. With a 10-minute age limit and per-container memory, expect a 30–60 %
  hit rate on the item-path routes during working hours, and higher on quiet
  deployments. Expect the most saved DynamoDB reads on deployments with many
  restricted (non-admin) users.
- **A 304** saves the response bytes (feedback pages run to tens or hundreds of KB)
  and the browser's parse. The server still answers, from the memo when it can.

## How to verify

```bash
API=$(aws cloudformation describe-stacks --stack-name VocApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text)
TOKEN=...   # a Cognito IdToken (see docs/deployment.md)

# 1. First call: 200, an ETag, revalidation headers
curl -s -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "${API%/}/metrics/summary?days=30" \
  | grep -i -E '^(HTTP|etag|cache-control|vary)'

# 2. Same call with the tag: 304, empty body
ETAG='W/"…"'   # from step 1
curl -s -D - -o /dev/null -H "Authorization: Bearer $TOKEN" -H "If-None-Match: $ETAG" \
  "${API%/}/metrics/summary?days=30" | head -1        # HTTP/2 304

# 3. A live route is never stored
curl -s -D - -o /dev/null -H "Authorization: Bearer $TOKEN" "${API%/}/chat/conversations/_list" \
  | grep -i cache-control                              # private, no-store

# 4. The counters (read-only)
aws dynamodb batch-get-item --request-items '{"voc-aggregates":{"Keys":[
  {"pk":{"S":"METRIC#meta"},"sk":{"S":"data_version"}},
  {"pk":{"S":"METRIC#meta"},"sk":{"S":"config_version"}}]}}'
```

Then change a review's category in the UI and repeat step 1. The ETag changes,
because the edit bumped `data_version`. In the browser's network tab, revalidated
requests show `304`.
