# Source policies: PII, restricted sources, retention and erasure

Not every feedback source can be handled the same way. A sales CSV can be read by everyone.
A support-ticket export usually holds names, email addresses and phone numbers: only a few
people should see it, personal data should be redacted, and it should be deleted after a
fixed time or on request. A **source profile** sets this up per source. Administrators
manage profiles; the rules then apply to every ingestion path, every reader and the AI
assistant.

## Source profiles

An admin manages profiles in **Administration → Privacy & access → Source policies** (`GET/PUT /settings/sources`). They are
stored in `voc-aggregates` as `pk=SETTINGS#sources, sk=config`, up to 50 of them:

| Field | Values | Default |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9_-]{0,47}$`. It is the item's `source_platform`: a plugin id (`github_issues`, …), a web scraper's **name** (see below), `feedback_form`, `manual_import`, or an import source an admin defines such as `sales_csv` or `support_tickets` | none (required) |
| `label` | Display name | none |
| `pii` | `allow` \| `redact` \| `summary_only` | `allow` |
| `retention_days` | `null` (keep forever) or 30–3650 | `null` |
| `retention_legal_basis` | Why the source's items are deleted after `retention_days` (≤ 300 characters, for example "DPA with vendor X, 12 months"). **Required** on `PUT /settings/sources` whenever `retention_days` is set (400 otherwise); `null` without a period. A profile saved before 6.00.00 with a period and no basis keeps running: its audit rows and tombstones say `legal_basis: "not recorded (set before 6.00.00)"`, and the Sources page flags it and asks for one before the next save | `null` |
| `restricted` | Hidden from users without an explicit grant | `false` |
| `dimension_defaults` | `{key: value}` applied when the message sets none ([dimensions.md](dimensions.md)) | `{}` |
| `tags` | Added to every item of the source | `[]` |

A source with no profile gets the defaults: PII allowed, kept forever, not restricted.

**Web scrapers.** A scraper's reviews do not carry the plugin id `webscraper`: each scraper
writes its own **name** (`name` in its config; the page's host name when it has none) as
`source_platform`, so a `webscraper` profile never matches anything. To give a scraper a
profile, name the scraper in the id format (for example `example_air_reviews`) and create a
profile with exactly that id. A scraper whose name has spaces, capitals or dots (such as
`Shop Reviews` or `www.example.com`) cannot have a profile until it is renamed, and renaming it
changes the source of its new reviews only. **Administration → Privacy & access → Source policies** suggests the scraper names
that fit the format, and never suggests `webscraper`.

`GET /settings/sources` returns the full profiles to an admin. Everyone else gets
`{sources: [{id, label, restricted}]}`.

## PII handling at ingestion

The policy is applied before **anything** is archived or queued, at every ingestion choke
point: plugin ingestors, webhooks, manual import (CSV/JSON), feedback forms and the data
explorer. This is `shared/source_policy.apply_source_policy`.

- **`allow`**: nothing changes.
- **`redact`**:
  - `text`, `title` and every string `metadata` value are redacted, and `author` is dropped.
  - Regex rules replace email addresses, phone numbers (E.164 and common EU/US formats),
    IBANs, payment cards (Luhn-checked, with an issuer prefix that issues that length, so a 13-digit timestamp or order id is kept) and IPv4/IPv6 addresses with `[EMAIL]`, `[PHONE]`,
    `[IBAN]`, `[CARD]` and `[IP]`.
  - Amazon Comprehend `DetectPiiEntities` additionally replaces names and addresses with
    `[NAME]` / `[ADDRESS]`. This runs only when `PII_COMPREHEND=1` (set on every ingestion
    Lambda) and only for a language Comprehend PII supports: **English and Spanish**. Text
    in any other language gets the regex rules only.
- **`summary_only`**:
  - The same redaction is applied, and then the processor stores **derived fields only**.
  - `original_text` becomes the (already redacted) `problem_summary`, or `[withheld]`.
  - `normalized_text`, `direct_customer_quote`, `author`, `title` and `metadata` are not
    stored.

An item's `pii_policy` attribute records the policy that was applied; an absent attribute
means `allow`. A raw archive (`raw/<source>/…` in S3) is written only for `allow` sources.

**Fail closed.** Every ingestion path reads the profiles with
`shared.source_profiles.cached_source_profile_strict`. When the profiles cannot be read,
nothing is archived or queued under the `allow` default: a plugin ingestor run fails (and
the next scheduled run retries), a webhook answers `503` (the provider re-delivers), and the
form submit, CSV/JSON upload and data explorer routes answer `503` with "Source settings are
temporarily unavailable; please retry shortly". The processor uses the policy the message
carries (`pii_policy_applied`); a message that carries none and whose profile cannot be read
is raised back to SQS and retried.

### Limitation: CSV whole-file archives

A CSV upload also archives the **whole file** under `raw/csv_upload/…` (a JSON upload under
`raw/json_upload/…`) before its rows are split: one file per upload, every row filed under the one
source the upload named. That archive is never redacted. Retention and a field erasure (author,
email, …) never rewrite it: when they delete a row it holds, the file is kept and listed on the job
(or retention audit row) as `files_needing_review` (keys only), because rewriting a CSV without the
erased rows would mean re-parsing it with a column mapping that is not stored. A whole-source
erasure deletes it, every version (see [Delete all data from a source](#delete-all-data-from-a-source)).
To keep personal data out of it, import a sensitive source with a source profile whose `pii` is not
`allow` and whose `retention_days` is set: such sources archive per item, after redaction,
and never as a whole file. A confirmed CSV correction ([csv-import.md](csv-import.md)) rewrites the
stored item's own per-item archive, so retention still deletes it with the item.

## Access: by category AND by source

An item is visible only if **both** of these rules admit it:

1. **The category rule**, described in [categories.md](categories.md).
2. **The source rule.** It comes from the caller's `CATEGORY_ACCESS` row
   (`pk=CATEGORY_ACCESS, sk=USER#{sub}`), field `sources`:

| Caller | Sources visible |
|---|---|
| Admin (not delegated) | All |
| `sources: ['*']` | All, including restricted ones |
| `sources: ['sales_csv', …]` | Exactly those |
| No `sources` field, or no row | Every source whose profile is not `restricted` |

**Example: "sales yes, support tickets no".**

- Create the profiles `sales_csv` (not restricted) and `support_tickets` (`restricted: true`,
  `pii: redact`, `retention_days: 365`).
- A product manager with no grant sees sales feedback but never support tickets.
- The support lead gets `PUT /users/{u}/category-access` with
  `{"categories": ["*"], "sources": ["support_tickets", "sales_csv"]}`.

Related routes:

- `GET /users/{u}/category-access` returns `{categories, sources}`. **`sources` is `null`
  when no grant is stored** (the default rule above applies).
- A `PUT` with `sources` omitted leaves the grant unchanged; `sources: null` clears a stored
  list back to the default rule (Administration → Privacy & access → Users → Category access → "Every source that is
  not restricted").
- `GET /feedback/access` returns `{all, categories, sources_all, sources, source_rule, sources_denied}`
  for the caller. `source_rule` is `all` (nothing hidden), `allow` (exactly `sources`) or `deny`
  (every source except `sources_denied`, the restricted ones). The AI assistant reads feedback
  straight from the table and applies BOTH rules to every list, count and by-id lookup; it
  admits nothing when `sources_all` is false and `source_rule` is missing or unknown.
  `sources` lists only explicit grants.

Routes that serve pre-computed counters fall back to the item path whenever the caller's
source rule hides anything, the same way they already do for a category restriction. The AI
assistant and MCP tokens act as the calling user, so the same rules apply to them.

## Retention and erasure

Customer data is deleted by two paths only, each for a legal obligation and each stating its
**legal basis** (TENETS.md → D5): the opt-in worker **`voc-retention`**
(`lambda/jobs/retention/handler.py`, in VocProcessingStack), which runs an erasure request or a
source's retention window, and participant erasure (`DELETE /participants/people/{id}`,
[participants.md](participants.md)), which deletes one person's rows in voc-participants.
`voc-retention` is the only worker that deletes feedback items, Radar reviews and raw archives.
`lib/customer-data-deletes.test.ts` pins, as an exact list, every role that may delete from
`voc-feedback` or `raw/` (it plus legacy grants that are never used and can only shrink).

| Mode | Trigger | Deletes |
|---|---|---|
| `retention` | Daily schedule, 04:15 UTC | Items (in `voc-feedback` and `voc-radar`) of sources whose profile sets `retention_days`, with `date` older than the cutoff, under the profile's `retention_legal_basis` |
| `erase` | `POST /settings/erasure` (admin) `{field, value, source?, legal_basis}` | Items where `field == value`. `field` is `author`, `source_id`, `csv_row_id` or `email` (`metadata.email` / `metadata.submitter_email`); optionally limited to one `source`, which is **required** for `source_id` and `csv_row_id` (an id is unique only within its source; 400 without it) |
| `erase`, `field: source` | `POST /settings/erasure` (admin), Administration → Privacy & access → Source policies → **Delete all data from a source** | Every item whose `source_platform` is the source, its Radar reviews, its whole-file uploads, then every object version left under `raw/<source>/` and `silver/<source>/` (see [Delete all data from a source](#delete-all-data-from-a-source)) |
| `erase` in one workspace (since 7.09.00) | `POST /settings/erasure` with `X-Workspace-Id` (that workspace's member admin) `{field, value, source?, legal_basis}` | That workspace's items only where `field == value` (`author`, `source_id`, `csv_row_id` or `email`; a whole source is refused, 400), with their copies under `ws/<ws>/` (see Workspace items, below) |

How it works:

- **Legal basis.** `legal_basis` is required on every `POST /settings/erasure` since 6.00.00: a
  non-empty text of at most 300 characters (`shared/legal_basis.py`), such as "GDPR art. 17 request
  #123"; **400** when it is missing or blank, and when it contains personal data the pattern pass of
  `shared/pii_redaction.py` finds (an email, phone number, card, IBAN or IP address): it is kept, as
  written, on the job row, its audit row and every tombstone, which are never deleted, so it must not
  identify the requester (a case or ticket number does that job). A retention run
  records each retained source's `retention_legal_basis` (`legal_bases` on its audit row).
- **Tombstones first.** Before an item is deleted, the worker writes its tombstone in
  `voc-aggregates`: `pk AUDIT#tombstone#<source>`, `sk <feedback_id>`, with `feedback_id`, `source`,
  `store` (`feedback` or `radar`), `mode`, `run_id`, `job_id` (erasure), `legal_basis` and
  `deleted_at`, and no content and no `ttl` (TENETS.md → D4). Tombstones are written for a scanned page
  before its deletes, one PutItem each (never BatchWriteItem, which would also allow deletes), so a
  crash or a hand-over can leave a tombstone whose item is still there (the next generation deletes
  it and rewrites the same key), never a delete without one.
- Each deleted item's raw objects go with it, every version and delete marker, in both layouts
  ([data-lake-structure.md](data-lake-structure.md)): the legacy `…/<stem>.json` object and every
  object under the item's folder `…/<stem>/` (one per archived content version), whichever of the
  two its `s3_raw_uri` names. `deleted_objects` counts the files removed. An API-side item received
  again on a later day lands in a new date folder; that older folder is removed by a whole-source
  erasure, not by the item's. Removing the item from DynamoDB moves the aggregate counters through
  the aggregator's REMOVE path.
- **Silver history.** Each deleted item's kept versions go with it: every object version under
  `silver/<source>/<feedback_id>/` (the item as it was before each edit, refresh or reprocess,
  [data-lake-structure.md → Silver history](data-lake-structure.md#silver-history-silver)), counted in
  `deleted_objects`. A whole-source erasure also sweeps what is left under `silver/<source>/`. A kept
  version holds only what its item held, and under a `summary_only` policy never the fields that policy
  drops (`normalized_text`, `direct_customer_quote`, `author`, `title`, `metadata`), even if an item from
  before 6.03.00 still holds them. **Removing personal data by hand** (a Data Explorer edit of a leaked email)
  keeps the version from before the edit, which still holds it. Erase the value BEFORE editing it out (the
  erasure matches the item while it still holds the value, and deletes the item with every kept version), or
  afterwards erase the item by a value it still holds (its `source_id`). An erasure by the removed value
  alone finds nothing, because it matches items as they are stored now (see "What erasure does not reach").
- **Radar.** After `voc-feedback`, the same match runs over `voc-radar` (other brands' reviews,
  [radar.md](radar.md)): each matching review row goes with its dedupe marker (`RADARID#<brand>`) and
  its own raw archive (`deleted_radar_items`). The brand's daily counters are kept: they hold
  counts only, no content.
- **Workspace artifacts that cited an erased item.** When a run deleted anything, it scans
  `voc-projects` for rows with `input_feedback_ids` or `evidence_feedback_ids` and looks each id up
  among the tombstones of the sources it deleted from. An artifact with an erased id loses that id
  from its lists and gains `erased_evidence: {count, job_id, mode, at}` (`count` adds up across
  runs; `artifacts_marked` on the job). Its text is never rewritten (it belongs to its owner); the
  update is conditional, so an artifact regenerated meanwhile is left for the next run.
- The worker walks its phases in order (`items`, `radar`, `boards` for an email erasure, `members` for
  an email erasure without a source, `raw` for a whole source, `lineage`) and
  hands over to a fresh invocation of itself, with its phase and cursor, before its 15-minute timeout.
- `POST /settings/erasure` answers 202 `{job}`. `GET /settings/erasure` lists the newest 20
  jobs, and the sources a whole-source erasure may name. A job shows `legal_basis`,
  `deleted_items`, `deleted_objects`, `deleted_radar_items`, `artifacts_marked`, once above 0
  `deleted_workspace_items` (Workspace items, below) and, when it kept whole-file uploads or an S3
  import's originals folder, `files_needing_review: {count, keys}` (a folder's key ends in `/`;
  Administration lists files and folders apart).
- The job row (`pk=JOB#erasure`) stores `value_hash`, the SHA-256 of the value. **The value
  itself is never stored or logged.** Each run also writes an audit row (`pk=AUDIT#retention`, no `ttl`).
- Whole-file upload archives (`raw/csv_upload/…`, `raw/json_upload/…`): deleted by a whole-source
  erasure only, otherwise kept and listed for review (see the limitation above).
- A per-item archive is named after the item's id when that id is filename-safe (letters,
  digits, `-`, `_`) and at most 64 characters, else `h.<sha256 of the id>`
  (`lambda/shared/archive_keys.py`); the worker deletes an item's object only under that
  name. Archives written before 3.06.00 for an id that was not filename-safe or was longer
  than 64 characters were named by sanitising and truncating the id, which let two items
  share one object; the worker no longer recognises those names, so delete such leftovers
  by hand (Data Explorer cannot delete; use the S3 console with an admin role).
- An `email` erasure is case-insensitive: ingestion stores `metadata.email` and
  `metadata.submitter_email` lower-cased, and the worker matches the lower-cased value as
  well as the value as typed (for items stored before that normalisation).
- **Feedback boards.** An `email` erasure without a source (or with the source
  `feature_requests`) also reaches `voc-feature-requests`: the person's requests and +1s are
  tombstoned (`AUDIT#tombstone#feature_requests`), their raw copies under
  `raw/feature_requests/` deleted (every version) and the rows de-identified (email and name
  removed; the request text stays; a +1, whose id derives from the email, is re-keyed under a
  new random id and still counts as a supporter). Counted as `board_items_deidentified`; artifacts that read
  such a request (`input_feature_request_ids`) are marked like for an erased review
  ([feature-requests.md → Erasure](feature-requests.md#erasure)).
- **Workspace memberships** (since 6.11.00). An `email` erasure without a source also reaches
  `voc-workspaces`: every membership row (`WS#{ws}` / `MEMBER#{sub}`) that holds the email, in any
  case, is tombstoned (`AUDIT#tombstone#workspace_members` / `{ws}#{sub}#{job}`: the workspace, the run and
  the legal basis) and de-identified: its `email` and `name` are removed and the membership stays
  (its role, `invited_by`, `joined_at`). Counted as `member_rows_deidentified`. The worker finds the
  rows with a paged Scan of the table (it has no email index), 100 items a page within the job's time
  budget, projecting the key and the email only (`lambda/jobs/retention/members.py`;
  [multi-workspace.md → Invites](multi-workspace.md#invites) says why not a look-up by account). The
  person's Cognito account is not part of the lake: deleting the user (`DELETE /users/{username}`)
  removes the account and its memberships.
- **Workspace items** (since 7.03.00; an erasure in one workspace since 7.09.00; [multi-workspace.md](multi-workspace.md)). An erasure job started
  without `X-Workspace-Id` is the deployment's (a deployment admin starts it), and a person's data is erased
  wherever it is: an erasure by `email` (with or without a source) also matches every workspace's items
  (`WS#{ws}#SOURCE#…` in `voc-feedback`) in the same item scan; Administration's erasure form and its confirm
  dialog say so. Such an erasure by `author`, `source_id` or `csv_row_id` does **not**: an author is a display
  name, not unique even within one source (the deployment's Jane Doe is not every workspace's Jane Doe), and an
  id is unique only within one source account or upload while each workspace has its own (the deployment's
  ticket 12345 is not a workspace's). **An erasure in one workspace** reaches them there: `POST
  /settings/erasure` with `X-Workspace-Id`, by a member admin of that workspace (a viewer or an editor 403;
  a non-member, the deployment's `admins` included, the one 404; a platform admin is not elevated on these
  routes and acts with their own membership, so a platform admin makes themselves a member admin first, in
  the platform console), writes the job row in the workspace's own partition (`WS#{ws}#JOB#erasure`) with
  `workspace_id` from the resolved membership only (a `workspace_id` in the body is dropped,
  `lambda/shared/erasure_scope.py`); one erasure per workspace runs at a time (a second start answers 409 until
  it finishes; a lock row in that partition, released when the job ends, stale after an hour), and
  `voc-retention` then erases
  that workspace's items only (`WS#{ws}#…`, by `author`, `source_id`, `csv_row_id` or `email`, optionally in
  one source, which `source_id` and `csv_row_id` still require), each tombstoned first, with its Silver
  versions and raw versions as below; never the deployment's items, another workspace's, Radar, the feedback
  boards or the memberships. An erasure by `email` in a workspace stays in it too: that workspace's admin
  answers for its data only, and the deployment's erasure by email still reaches everyone's. The worker reads
  the row from the partition its invoke event names and fails the job (`Run failed (ValueError)`, nothing
  deleted) when the row names another workspace, none, or one on a whole-source job; it checks every matched
  row's partition before any tombstone; the job and audit rows carry `workspace_id` and count the items in
  `deleted_workspace_items`, and the workspace's own data_version moves. **A workspace's exports** are a derived
  copy (its feedback and members in a zip under `ws/{ws}/exports/`, docs/multi-workspace.md "Export and
  delete"): the moment any erasure (the deployment's by email, or one in the workspace, which does it at its start)
  first meets a workspace, before it deletes the item or changes the membership row (the export's `members/` holds
  the email), it takes the workspace's export lock (a start answers 409) and marks every queued, running or
  completed export of that workspace `erased` (no download link is signed for it again; one under way reads "The
  workspace's data was erased during the export"). Its `exports` phase, after the item scan and the memberships
  and before the lineage pass, marks them again (an export started since), aborts its open
  export upload, deletes every version of every object under `ws/{ws}/exports/`, then sweeps once more
  (`lambda/jobs/retention/exports.py`), counted in `deleted_export_objects`. An export invocation that was mid-write
  finds its row erased at its next hand-over, or right before it completes the zip (it re-checks the row then: an
  erasure that marks it after that check comes before its sweep's abort and delete), aborts its upload and deletes
  the work objects it wrote, and never completes; until then
  (at most one 15-minute invocation) it may write after the sweep, and a work object it deletes keeps a noncurrent
  version until the export lifecycle rule removes it a day later (a gap TENETS.md D5 names). Two more gaps it names:
  a large CompleteMultipartUpload still running while both sweeps finish can leave its zip until its 10-day expiry
  (no link is signed for it: its row reads erased), and an export invocation the timeout or memory kills inside that
  window leaves its parts until the 7-day abort of incomplete uploads and its work objects until their 10-day
  expiry. The erasure holds the workspace's export lock from its first mark until after its last sweep, so no
  export starts meanwhile (a start answers 409, "An erasure is running in this workspace"): each hand-over renews
  it and marks any export that slipped in, so it never goes stale while the run is under way. A run that fails
  before its exports phase leaves the lock to go stale (an hour). An erasure in one workspace closes, and its
  exports phase then deletes, that workspace's exports even when it matches nothing there (the close comes before
  the scan). A daily
  retention window does not run it: a window's deleted items stay in an export until it expires (10 days). A job that already finished keeps its
  outcome: a repeated invocation that fails never turns a completed workspace job into failed. A **whole-source erasure** in a
  workspace is refused (400) before anything is read (an unknown field gets the usual "field must be one of"
  answer): the sources it may name, its lock and its sweep of `raw/<source>/` are the deployment's (a
  workspace's own whole-source erasure, over its counters, its own lock and `ws/{ws}/raw/<source>/`, is a
  follow-up). A workspace's job never blocks the deployment's whole-source erasure of the same source. Like
  every erasure, a workspace's job is one whole-table Scan of `voc-feedback` (its items span many partitions and
  no index serves one workspace's items); one live job per workspace bounds that cost, and a per-workspace index
  is a later optimisation.
  `GET /settings/erasure` with the header lists that workspace's newest 20 jobs (one Query of its partition)
  and no sources; without it, the deployment's jobs as before. Inside a workspace, Administration sends the header for an erasure by author, source id, CSV row or email, and lists that workspace's jobs; a whole-source erasure is sent without it. A **retention window** reaches workspace items too:
  the windows are the deployment's. Since 7.08.00 a workspace's messages are processed under the workspace's
  own source profiles (their PII policy, restriction, defaults and tags; a source the workspace saved no profile
  for redacts personal data by default, never takes the deployment's profile), but a workspace's profile sets no window (the settings API
  refuses one), and at ingestion it carries the deployment's window for its source, so a source with a window
  keeps no whole-file original there either (the window deletes item by item) and the deployment's window
  binds the workspace's items. Each one is tombstoned first,
  in the same partition as the deployment's (`AUDIT#tombstone#<source>`, which the audit-row guard
  protects; a `WS#{ws}#…` partition would be outside it) with the workspace in its sort key and row
  (`sk <ws>#<feedback_id>`, `workspace_id`), so two workspaces' copies of one source item and the
  deployment's never share a tombstone. Then the item goes with its own copies, all under its
  workspace: every version of its raw objects under `ws/{ws}/raw/…` and every kept Silver version under
  `ws/{ws}/silver/<source>/<feedback_id>/`. A workspace item follows its `s3_raw_uri` only under its own
  `ws/{ws}/raw/` (a deployment item only under `raw/`), so no item reaches another scope's objects. A row
  whose partition starts `WS#` but names no workspace is never handled as the deployment's: an erasure job
  fails (`Run failed (ValueError)`) before that row, or anything after it on its page, is deleted, and stops
  there; the daily retention run skips the row and counts it instead (`unscoped_rows_skipped` on its audit
  row, metric `RetentionUnscopedRowsSkipped`; it may count a row more than once across a hand-over, above 0
  is what matters), so the deployment's windows keep running. **Runbook:** an erasure that fails with
  `Run failed (ValueError)` and does not name a whole source, or a retention audit row with
  `unscoped_rows_skipped`, means such a row exists: find it (a Scan of `voc-feedback` for a `pk` that
  starts `WS#` but has no `ws_` + 26-character id after it) and remove it by hand; until then every erasure
  that matches that row (an erasure by email whose value it holds) stops at the same point. The job and audit rows count workspace items in `deleted_workspace_items` (part of
  `deleted_items`, shown once above 0, also in Administration). The lineage pass finds no workspace item:
  its lookup is by `{feedback_id}` tombstone keys, a workspace tombstone's is `<ws>#<feedback_id>`, and the
  deployment's artifacts cite deployment items only (projects are keyed by workspace in phase 3); a run that
  deleted only workspace items does not scan `voc-projects`. **A whole-source erasure does not reach
  workspace items**: it is a request about the deployment's own source.
- **S3 import originals.** The `s3_import` plugin keeps each imported file as uploaded under
  `raw/s3_import/…` (`ws/{ws}/raw/s3_import/…` for a run in a workspace) when its profile keeps whole files,
  and no row links an item to the file it came from. An erasure (by email, author, …) that deletes an S3 import's
  item (its `source_platform` is `S3 - <folder>`) keeps the file and lists that scope's originals folder
  (the `s3_import` folder under `raw/` or `ws/{ws}/raw/`) in `files_needing_review` when it holds any file
  (listed once per folder and invocation, paging past delete markers): an admin removes the person's rows
  by hand, as for a kept whole-file upload. A retention window never meets one: an import's
  `S3 - <folder>` is no profile id, and a profile with a window keeps no originals.

### Delete all data from a source

Removes a whole dataset in one job: a mis-imported CSV, a demo or test source, a Web Reviews page
you no longer track.

> **The source keeps running.** Deleting its data does not turn it off. If its schedule or plugin is
> enabled, new reviews keep arriving during and after the job: **disable the source first** (Data
> sources page) if it should stay empty. The dialog says so, and shows a warning when the source's own
> schedule is on (from the `GET /sources/status` read the Sources page already makes; a source with no
> schedule of its own, such as one Web Reviews page or a feedback form, gets the plain note only).
> The CSV and JSON files uploaded to the source (`raw/csv_upload/…`, `raw/json_upload/…`) are
> **deleted** with its reviews: every row of such a file is filed under the source its upload named.

The request is `POST /settings/erasure` with
`{field: 'source', value: '<source id>', confirm: '<source id>', legal_basis: '<why>'}`:

- `confirm` must repeat the source id exactly (a server-side type-to-confirm; the Settings dialog
  sends what the person typed). Otherwise **400**.
- The source must be known: a configured source profile, or a source the aggregator has counted
  (a `METRIC#daily_source#<id>` row). That includes sources without a profile, such as each Web
  Reviews page (`web_<site>_<app>`). Otherwise **400** `Unknown source`. `GET /settings/erasure`
  answers `{jobs, sources}`, where `sources` is that list. The counted sources are read keys only and
  deduped while paging, and kept for 60 seconds in a warm container, so a just-counted source can take
  up to a minute to appear.
- **409** while another erasure job of the same source is queued or running. A live job whose row
  has not moved for an hour (`progress_at`, else `created_at`) is treated as dead and does not block;
  so is a live row with neither timestamp readable (logged), so a malformed row cannot block the
  source forever.
  Two starts in the same instant cannot both pass: the start also takes the source's lock row in
  `voc-aggregates` (`pk JOB#erasure`, `sk SRCLOCK#<source>`, `job_id`, `locked_at`) with a conditional
  write that succeeds only when there is no lock, it was released, or it was taken more than an hour
  ago. The loser answers **409**. The worker releases the lock when the job completes or fails, by
  setting `released_at` (an UpdateItem that names the job, so a job whose stale lock was taken over
  never frees its successor's; `voc-retention` holds no delete on `voc-aggregates`). A start whose
  worker invoke fails releases it at once. Each hand-over keeps it and renews `locked_at`, so a job
  that runs for hours never presents a stale lock. Renewing and releasing are best effort: a failure
  is logged, never fails the run, and an unreleased lock goes stale after an hour.
- The job row keeps `field: 'source'`, `source` and the usual `value_hash` (the SHA-256 of the
  source id, for one audit shape across modes).

What the worker does:

0. **Check.** The job row must name the invoked source (`source` = the invoke `value`) and that id
   must match the source-id pattern the route checks (`SOURCE_ID_RE`). Otherwise the job fails with
   `Run failed (ValueError)` before anything is deleted (defence in depth for a job row written some
   other way).
1. **Reviews.** It scans `voc-feedback` with a `source_platform = <source>` filter, writing each
   page's tombstones, then deleting each item with its own per-item archive and the whole-file upload
   it came from (every version). It does not Query `pk = SOURCE#<source>`: an item's
   partition is `SOURCE#<brand_name or source_platform>` (the processor), so a deployment with a
   brand name keeps every plugin's items in one brand partition, and feedback forms use their own
   brand's. Only the attribute tells sources apart.
2. **Radar reviews.** The same scan over `voc-radar`, for a source that sends its reviews to Radar.
3. **Raw files.** It then deletes every object version and delete marker under `raw/<source>/`,
   1,000 at a time, including archives no item points at any more. The prefix ends in `/`, so
   erasing source `web` never reaches the folder of a source named `web_shop`.
4. **Lineage.** It marks the personas and documents that cited a deleted review (see above).
5. **Progress.** While it runs, the job row carries `deleted_items`, `deleted_objects`,
   `deleted_radar_items`, `artifacts_marked`, `phase` (`items`, `radar`, `raw`, then `lineage`) and
   `progress_at`, refreshed when the counts move and at least every
   minute. `deleted_objects` counts files: the per-item archives, the uploaded files, plus each key
   under the folder that still held a version (a delete marker alone is not counted). It hands over
   to a fresh invocation before its timeout, in any phase.
6. **Metrics.** Each DeleteItem reaches the aggregator as a stream REMOVE, which decrements every
   counter the insert added (pinned by `TestADeleteReversesExactlyWhatTheInsertAdded` in
   `lambda/aggregator/test/test_handler.py`). Dashboard counts fall while the job runs, and an open
   Administration page refreshes the app's feedback views when it sees a job it showed running end.
   The `METRIC#daily_source#<id>` rows stay at 0, so the source stays in the picker.

What it keeps:

| Kept | Why |
|---|---|
| An uploaded CSV / JSON file of the source that no remaining item points at | The worker finds an upload through the items that came from it. A file whose items were all deleted earlier (or point at a newer upload) is not reached; find it by its `source_id` S3 metadata under `raw/csv_upload/` / `raw/json_upload/` and delete it by hand |
| The source profile, plugin settings, schedule and credentials | Deleting data is not removing the source. New reviews keep arriving until you disable the source (Data sources page) or remove its profile |
| The source's watermark (`voc-watermarks`) | Kept on purpose: the next scheduled run continues from where it stopped and does not import the deleted history again. To re-import it, delete the source's `voc-watermarks` row by hand (admin role) |
| Radar daily counters of the source's brand | Counts only, no content; Radar reads its love / hate themes from the reviews, which are gone |
| Logs, run records and circuit-breaker rows of the source | Operational rows, not customer feedback |
| The tombstones and the audit row | The record of the deletion (no content) |

### What erasure does not reach

Retention and erasure delete **feedback items, Radar reviews, their own per-item raw
archives and the items' kept Silver versions**, the whole-file uploads of an erased source, and the erased ids from the lineage lists of
workspace artifacts. Copies derived from a review before it was erased stay where they are:

| Copy | Where | What to do |
|---|---|---|
| Problem summaries and quotes inside generated persona, PRD, PR/FAQ and research documents | `voc-projects` (and its document versions) | The artifact carries `erased_evidence` once a cited review is erased. Open the project, find the person's words, edit or regenerate the document (regeneration reads the current feedback, which no longer has the item) |
| AI assistant conversations that quoted the review | `voc-conversations`, partition of each user who asked | The user deletes the conversation (`DELETE /chat/conversations/{id}`); an admin can ask affected users to do so |
| Memories extracted from conversations or agent runs | `voc-memory` (never deleted by design) | Mark the memory forgotten in the Memory page (`/memory/{id}/forget`), which hides it from retrieval |
| Idempotency rows of the processor | `voc-idempotency` | Keyed by a hash of the message, they may cache the processor's response for up to an hour, then expire through the table's TTL (`expiration`); wait an hour, or delete the row by hand |
| Whole-file CSV / JSON uploads that also hold rows that were not erased | `raw/csv_upload/…`, `raw/json_upload/…` in the raw bucket | Listed on the job as `files_needing_review` (Administration shows the keys). Remove the person's rows by hand (download, edit, delete every version with an admin role, re-upload if needed), or avoid it by giving the source a retention period or a non-`allow` policy |
| An S3 import's original file | `raw/s3_import/…`, a workspace's `ws/<ws>/raw/s3_import/…` | No row links an item to its file: the job lists the folder as `files_needing_review` when it deleted an import's item and the folder holds a file. Find the file by its `original-key` S3 metadata, remove the person's rows by hand (every version, admin role) |
| Archives named before 3.06.00 for ids that were not filename-safe | `raw/<source>/…` | See the archive naming note above |
| A workspace export holding items a daily retention window deleted (an erasure deletes the workspace's exports at once) | `ws/<ws>/exports/…` | It expires by its tag 10 days after it was written; to remove it sooner, delete every version under that export's folder with an admin role |
| The person's account in the user pool (email, name) | Cognito, the deployment's directory (not the lake) | Delete the user (`DELETE /users/{username}`, Administration → Users), which also removes their workspace memberships; while the account exists, a workspace's members list shows its email from Cognito |
| An old value kept only in a Silver version (an `author` or email a CSV correction or an edit replaced) | `silver/<source>/<feedback_id>/` | A field erasure matches items as they are stored now, so it reaches every kept version of an item that still holds the value, but not a version whose item has moved on. Erase by the item's current value as well, or delete every version under that item's folder with an admin role |

**The corpus ids on generated artefacts.** A persona, research report, PRD, PR/FAQ or
merged document stores `input_feedback_ids`, the ids of the reviews its prompts held
([project workspace](project-workspace.md#which-feedback-a-generation-reads)), and a persona its
cited `evidence_feedback_ids`. Only ids are stored, never review text. After a run deletes items,
the worker removes their ids from these lists and marks the artefact with `erased_evidence`
(above), so lineage never points at a deleted review.

Record what you removed by hand next to the erasure job: the job row keeps only the value's
hash and the legal basis, so it is safe to reference.

Least-privilege grants (`lib/stacks/retention-worker.ts`):

| Resource | Allowed actions |
|---|---|
| Feedback table | `GetItem`, `Query`, `Scan`, `DeleteItem` |
| Radar table | `Scan`, `DeleteItem`; `UpdateItem` on the `SETTINGS#radar` partition only (the Radar cache version) |
| Projects table | `Scan`, `UpdateItem` (no delete, no put) |
| Feature requests table | `Scan`, `GetItem`, `Query`, `UpdateItem` (de-identifies board rows, recounts totals); `PutItem` / `DeleteItem` under `FR#*` only (re-keys an erased +1) |
| Workspaces table | `Scan` (finds the membership rows that hold an erased email); `UpdateItem` pinned to `WS#*` and the attributes `email` and `name` (de-identifies a `MEMBER#` row). No put, no delete; the audit-row guard denies it any `AUDIT#` row |
| Raw bucket | `DeleteObject` and `DeleteObjectVersion` on `raw/*`, `silver/*` and each workspace's `ws/ws_<26 ?>/raw/*` and `ws/ws_<26 ?>/silver/*` (one workspace id per pattern: IAM's `*` also matches `/`), plus `ListBucketVersions` with those prefixes. The whole-file uploads are under `raw/`: the code deletes one only for a whole-source erasure of its own source. The workspace prefixes are reached by an erasure by email and a retention window (D5, legal obligations), never by any other erasure (in code). An explicit Deny refuses deletes under `ws/ws_<26 ?>/raw/s3_import/*`: a workspace's S3 import originals are listed for review, never deleted |
| Aggregates table | `GetItem`, `PutItem` (also each tombstone), `UpdateItem`, `Query`, `BatchGetItem` (the lineage pass's tombstone lookups); no delete |
| KMS | Encrypt/decrypt |
| Lambda | Invoke itself |
