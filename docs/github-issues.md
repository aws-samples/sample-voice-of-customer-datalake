# GitHub Issues connector

`plugins/github_issues/` ingests issues and their comments from GitHub repositories as feedback,
with the software version each report is about, so the Dashboard can show trends per release
and per label. It is **enabled** in the shipped `voc-datalake/cdk.context.json` (`"github_issues": true`
under `pluginStatus`) and stays idle — "nothing to fetch", no GitHub call — until a token and at
least one repository are saved. Set it to `false` to deploy without its two Lambdas.

## Setup

1. **Create a fine-grained personal access token** (GitHub → Settings → Developer settings →
   Fine-grained tokens):
   - *Repository access*: only the repositories you will list.
   - *Repository permissions*: **Issues: Read-only** and **Metadata: Read-only** (GitHub adds
     Metadata automatically). Nothing else, and no account permissions.
   - Pick an expiry and put a reminder on it — an expired token shows up as failed runs
     (`GitHub 401`) and, after five in a row, a circuit-broken schedule.
2. Deploy with `"github_issues": true` in `pluginStatus` (the default; `npm run generate:config`
   regenerates the frontend manifest after any change), and fill in the plugin's fields in the
   Settings UI:
   - **Repositories**: one per line, up to 20. `owner/name`, or any GitHub URL inside the
     repository — `https://github.com/owner/name`, `…/name/issues`, `…/name/issues/42`,
     `…/name/pulls`, a `.git` clone URL. Only the first two path segments count. An entry that
     names no GitHub repository (another host, a bare `a/b/c`, a typo) is ignored and logged as
     a warning on every run, so it shows up in the plugin's logs rather than as silence.
   - **Token**: the token above. It is stored in the plugin's namespace of the shared Secrets
     Manager secret (`github_issues_token`). The plugin sends it only as the `Authorization`
     header to `api.github.com` (it refuses to follow a `Link` header to any other host), never
     logs it, and no API route returns it.
   - **Labels** (optional): ingest only issues carrying ANY of these labels (comma-separated,
     case-insensitive).
   - **Product names** (optional): names a body may cite a version under, e.g. `Kiro` so
     "Kiro 0.4.2" is read as release 0.4.2. Each repository's own name is added automatically.
   - **Only issues and comments created on or after** (optional, `YYYY-MM-DD`, midnight UTC):
     bounds a backfill. Each issue and each comment is judged by its own `created_at`, so a new
     reply on an old issue is still ingested. The listing's `since` is raised to this day too,
     so the pages of older issues are never fetched. An invalid date is ignored (no bound).
   - **Skip authors with these GitHub roles** (optional, comma-separated `author_association`
     values: `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`,
     `FIRST_TIMER`, `MANNEQUIN`, `NONE`): keeps the maintainers' own issues and replies out of
     customer feedback. Also judged per item: a customer's reply on a maintainer's issue is
     still ingested. Unknown values are ignored.

   Labels select the THREAD (an issue outside them drops its comments too); the date and role
   filters select individual ITEMS. The webhook applies all three exactly as the poller does.

### Sizing a large repository

Every ingested item costs one Bedrock call plus Comprehend in the processor, so the filters above
— not GitHub's quota — are the main cost control. Measured against `kirodotdev/KiroCrew` (6,571
issues, 10,907 pull requests) with the plugin's own client:

| | Value |
|---|---|
| Pull requests in the issues listing | ~46% of entries (skipped, but each page still costs a request) |
| Bot comments (`github-actions[bot]`) | ~1 in 3 (skipped) |
| Human comments per issue | ~1.5 |
| GitHub latency | ~0.4 s per request |
| Full backfill, no filters | ~16,500 items, ~6,400 requests |
| Per run | the 1,500-item cap is reached after ~550 requests (~3.5 min) |

So a full unfiltered backfill completes over ~11 scheduled runs (~5–6 hours) and uses roughly
1,100 requests an hour — well inside a token's 5,000. A start date and `OWNER, MEMBER,
COLLABORATOR` are what shrink it.
3. Enable the schedule (every 30 minutes). "Run now" works as for every source.

### Private repositories

Supported, with the same token. A fine-grained token can be granted access to private
repositories of the account or organisation that owns it (an organisation may require an admin
to approve the token). Read-only **Issues** + **Metadata** is still all that is needed. Two
things to know:

- GitHub answers **404**, not 403, for a repository the token cannot see. The ingestor logs
  "not found or not visible to the token", skips that repository and carries on with the others
  — so a missing grant shows as a repository with no data, not a failed run.
- Issue text from a private repository becomes ordinary feedback in the data lake: visible on
  the Dashboard, in search and to the assistant for every user whose category access covers its
  category. Restrict categories (Settings → Categories, user category access) if that matters.

The design-system GitHub token (`voc/design-integrations`) is deliberately **not** reused: it
lives in a different secret with different readers, and a separate, issues-only token keeps both
blast radiuses small.

## Real-time delivery (optional webhook)

The poller alone is complete; the webhook only removes the up-to-30-minute delay.

1. Pick a random secret (e.g. `openssl rand -hex 32`) and save it as **Webhook secret** in the
   plugin's settings.
2. In each repository: Settings → Webhooks → Add webhook:
   - Payload URL: `<API endpoint>/webhooks/github_issues`
   - Content type: `application/json`
   - Secret: the same secret
   - Events: *Issues* and *Issue comments*.

`POST /webhooks/github_issues` is public at the gateway (GitHub cannot present a Cognito token)
and carries its own explicit stage throttle. The handler authenticates every delivery before
reading it:

| Check | Refusal |
|---|---|
| A webhook secret is configured | 503 — fail closed, never "accept unsigned" |
| Body at most 1 MB | 413 |
| `X-Hub-Signature-256` present and equal to `sha256=` + HMAC-SHA256(raw body, secret), constant-time compare | 401 |

Verified deliveries for an unconfigured repository, pull requests, bot comments, deletions,
`ping` and other events are acknowledged with 200 and dropped. A webhook item and a later poll
of the same issue share one id, so the processor keeps one.

## What is ingested

| Item | Id | Text |
|---|---|---|
| Issue | `owner/name#123` | title + body (markdown stripped, code blocks cut to their first lines, capped at 4,000 chars) |
| Comment | `owner/name#123/comment-<id>` | `Re: <issue title>` + body (capped at 2,000) |

Pull requests (which GitHub's issues API also returns) and comments by bots are skipped.

**Comments are separate items, linked by `parent_id`, not folded into the issue.** The processor
never updates a feedback item it has already stored (it skips any id it has seen), so a folded
issue would freeze with the comments that existed at first ingest — and the "+1, still broken on
0.4.3" replies that carry most of the signal would be lost. As their own items, comments are
categorised and scored on their own and carry their own version mention.

The same rule means an issue's **first** ingest is what is stored: a later label, state change or
edit does not update it. The raw archive keeps the payload as of that ingest.

Every item's untouched GitHub payload is archived to the raw bucket
(`raw/github_issues/{y}/{m}/{d}/<id>.json`) by both the ingestor and the webhook, like every
source.

### `issue_attributes`

Computed deterministically in the plugin (`plugins/_shared/github_text.py`, no model call), so
two reports of one bug produce the same values and cluster. Validated by
`schemas.IssueAttributes` and stored on the feedback item as one map:

| Field | Meaning |
|---|---|
| `kind`, `repo`, `number`, `parent_id` | issue or comment; a comment's `parent_id` is its issue's item id |
| `state`, `state_reason`, `milestone`, `labels` | as on GitHub (a comment carries its issue's) |
| `plus_one`, `reactions_total` | 👍 count and all reactions; the UI's **reach** is `1 + plus_one` |
| `author_association` | `OWNER`, `MEMBER`, `CONTRIBUTOR`, `NONE`, … |
| `comment_count`, `updated_at` | issue only / as on GitHub |
| `linked_prs` | PR numbers the text links (`github.com/<repo>/pull/N`, `PR #N`); a bare `#N` is not counted — it may be an issue. GitHub's own linked-PR relation lives in the timeline API (one extra request per issue) and is not read |
| `software_version`, `version_source` | see below |
| `component` | an `area:` / `component:` / `scope:` label, else an issue-form *Component* / *Area* field |
| `error_signature` | the first error line (code blocks first), lower-cased, with numbers, quoted strings, paths, URLs, hex and UUIDs masked: `TypeError: Cannot read properties of undefined (reading 'id')` → `typeerror: cannot read properties of undefined (reading <str>)` |
| `has_repro` | an answered issue-form *Steps to reproduce* field, or the usual phrases in free text (an unanswered `_No response_` field is not a repro) |

### Software version

`parse_software_version` takes the **first confident match** in this order, else none (a guess
would split one release's trend across fake versions):

1. **Issue form**: a `### … Version` section (`### Version`, `### Kiro version`, `### App
   version`) whose answer contains a version — not one naming the environment (`### OS version`,
   `### Node version`).
2. **Labels**: `v1.2.3`, `version:1.2`, `version/1.2`.
3. **Body**: `version: x.y.z` (unless the word before is an environment, as in `Node version:
   18`), then `<product> x.y.z` for the configured / repository product names (`Kiro 0.4.2`),
   then a bare `v0.4.2` (v-prefixed, three parts, not after `node`, `macOS`, …).

The leading `v` is dropped; a pre-release suffix is kept (`1.0.0-beta.2`). A comment's own
mention wins; otherwise it inherits its issue's version.

## Incremental fetch and rate limits

REST, not GraphQL: the REST issues endpoint supports `since=` and conditional requests, and a
304 answer does not count against the quota, which GraphQL cannot offer. Per repository, per run:

- `GET /repos/{repo}/issues?state=all&sort=updated&direction=asc&since=<watermark>` — oldest
  change first, so the watermark advances issue by issue; `Link: rel="next"` pagination.
- `If-None-Match` with the ETag of the last listing made at the same `since` — an unchanged
  repository costs one free 304.
- For each changed issue with comments: `GET …/issues/{n}/comments?since=<watermark>` (a new
  comment bumps its issue's `updated_at`, so every new comment is seen).
- The watermark (`github_issues#repo#<owner/name>` in the watermarks table) stores `since`, the
  issue numbers already processed at that instant (`since` is inclusive) and the ETag. It is
  committed **only after** every item of the run reached the processing queue, so a failed run
  re-fetches instead of skipping.

The run **never sleeps**. It stops early — successfully, keeping its progress, resuming next
run — on a 403/429 with `Retry-After` or an exhausted quota, when fewer than 25 requests of quota
remain, when less than ~20 seconds of the Lambda's budget is left (60 s is kept back for the
final queue send), or after 1,500 items. A 404 skips that repository; a 401 (bad or expired
token) or a 5xx fails the run and counts against the circuit breaker.

With the 5,000 requests/hour of a token, a 30-minute schedule covers well over a hundred busy
repositories; the 1,500-item cap is what bounds a first backfill (it completes over several runs).

**Why not the `gh` CLI or no token.** `gh` calls this same REST API with a token under the same
5,000/hour limit, so it buys nothing and would be a binary to ship in an ARM64 Lambda.
Unauthenticated requests get 60/hour per IP, shared with every other tenant on Lambda's egress
addresses. A GitHub App (up to 15,000/hour, not tied to a person) is not supported.

**Why per-issue comment fetches, not the repository-wide comments listing.**
`GET /repos/{repo}/issues/comments` would cut a backfill's requests by ~13× (≈300 pages instead
of ≈6,200 calls for KiroCrew). But each repository-wide comment carries only its issue's URL, so
mapping it needs the parent issue (title, labels, version), which a resumed run may not have seen
— one extra request per uncached parent, which gives most of the saving back. And requests are
not the bottleneck: the item cap and the processor's per-item model call are.

## Pull-request discussions

Not ingested. PR review threads are mostly code review, not customer voice, and would dilute the
trends. PR numbers an issue links are kept in `linked_prs`. Adding them later is a second
listing (`GET /repos/{repo}/pulls` + review comments) behind its own toggle.

## Where it shows up

- **Dashboard → GitHub Issues** (only when the window holds GitHub feedback): reports and average
  sentiment per release, what is new in the latest release compared with every earlier release in
  the window (error signatures, components, categories), its top complaints and errors, and a
  per-label table with reach and open count. A repository picker appears with more than one repo.
- **`GET /metrics/github?days=&date_basis=&repo=`** (`lambda/api/metrics_handler.py` +
  `lambda/shared/github_metrics.py`): the same breakdown, computed from the items after the caller's category
  filter, with the usual `is_partial` / `partial_reason` / `scanned_through`.
- **`GET /feedback?version=0.4.2&label=bug`**: list filters (also on `/feedback/urgent`).
- **AI assistant**: `get_metrics` with `metric: "github"`, and `search_feedback` with
  `version: "0.4.2"`.

## Files

| Path | Role |
|---|---|
| `plugins/github_issues/manifest.json` | config fields, schedule, webhook declaration |
| `plugins/github_issues/ingestor/handler.py` | polling, watermarks, commit-after-send |
| `plugins/github_issues/webhook/handler.py` | signature check, event filtering |
| `plugins/_shared/github_text.py` | version / error signature / component / repro / markdown (pure) |
| `plugins/_shared/github_mapping.py` | payload → feedback item, shared by both Lambdas |
| `plugins/_shared/github_api.py` | REST client: ETag, Link pagination, rate-limit and budget stops |
| `plugins/_shared/github_config.py` | repos (URL parsing) / labels / product names / start date / excluded roles from the plugin secret |
| `plugins/_shared/raw_archive.py` | the raw-archive write both transports share |
| `plugins/github_issues/test/` | pytest: parsing tables, mapping, scripted GitHub responses, webhook |
