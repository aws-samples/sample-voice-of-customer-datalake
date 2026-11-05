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
| `erase`, `field: source` | `POST /settings/erasure` (admin), Administration → Privacy & access → Source policies → **Delete all data from a source** | Every item whose `source_platform` is the source, its Radar reviews, its whole-file uploads, then every object version left under `raw/<source>/` (see [Delete all data from a source](#delete-all-data-from-a-source)) |

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
- The worker walks its phases in order (`items`, `radar`, `boards` for an email erasure, `raw` for a
  whole source, `lineage`) and
  hands over to a fresh invocation of itself, with its phase and cursor, before its 15-minute timeout.
- `POST /settings/erasure` answers 202 `{job}`. `GET /settings/erasure` lists the newest 20
  jobs, and the sources a whole-source erasure may name. A job shows `legal_basis`,
  `deleted_items`, `deleted_objects`, `deleted_radar_items`, `artifacts_marked` and, when it kept
  whole-file uploads, `files_needing_review: {count, keys}`.
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
  removed; the request text stays). Counted as `board_items_deidentified`; artifacts that read
  such a request (`input_feature_request_ids`) are marked like for an erased review
  ([feature-requests.md → Erasure](feature-requests.md#erasure)).

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

Retention and erasure delete **feedback items, Radar reviews and their own per-item raw
archives**, the whole-file uploads of an erased source, and the erased ids from the lineage lists of
workspace artifacts. Copies derived from a review before it was erased stay where they are:

| Copy | Where | What to do |
|---|---|---|
| Problem summaries and quotes inside generated persona, PRD, PR/FAQ and research documents | `voc-projects` (and its document versions) | The artifact carries `erased_evidence` once a cited review is erased. Open the project, find the person's words, edit or regenerate the document (regeneration reads the current feedback, which no longer has the item) |
| AI assistant conversations that quoted the review | `voc-conversations`, partition of each user who asked | The user deletes the conversation (`DELETE /chat/conversations/{id}`); an admin can ask affected users to do so |
| Memories extracted from conversations or agent runs | `voc-memory` (never deleted by design) | Mark the memory forgotten in the Memory page (`/memory/{id}/forget`), which hides it from retrieval |
| Idempotency rows of the processor | `voc-idempotency` | Keyed by a hash of the message, they may cache the processor's response for up to an hour, then expire through the table's TTL (`expiration`); wait an hour, or delete the row by hand |
| Whole-file CSV / JSON uploads that also hold rows that were not erased | `raw/csv_upload/…`, `raw/json_upload/…` in the raw bucket | Listed on the job as `files_needing_review` (Administration shows the keys). Remove the person's rows by hand (download, edit, delete every version with an admin role, re-upload if needed), or avoid it by giving the source a retention period or a non-`allow` policy |
| Archives named before 3.06.00 for ids that were not filename-safe | `raw/<source>/…` | See the archive naming note above |

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
| Feature requests table | `Scan`, `UpdateItem` (de-identifies board rows; no delete, no put) |
| Raw bucket | `DeleteObject` and `DeleteObjectVersion` on `raw/*`, plus `ListBucketVersions` with the `raw/` prefix. The whole-file uploads are under `raw/`: the code deletes one only for a whole-source erasure of its own source |
| Aggregates table | `GetItem`, `PutItem` (also each tombstone), `UpdateItem`, `Query`, `BatchGetItem` (the lineage pass's tombstone lookups); no delete |
| KMS | Encrypt/decrypt |
| Lambda | Invoke itself |
