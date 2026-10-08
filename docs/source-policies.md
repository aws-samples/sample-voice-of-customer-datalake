# Source policies: PII, restricted sources, retention and erasure

Not every feedback source can be handled the same way. A sales CSV can be read by everyone.
A support-ticket export usually holds names, email addresses and phone numbers: only a few
people should see it, personal data should be redacted, and it should be deleted after a
fixed time or on request. A **source profile** sets this up per source.

## Source profiles

An admin manages profiles in **Settings → Sources** (`GET/PUT /settings/sources`). They are
stored in `voc-aggregates` as `pk=SETTINGS#sources, sk=config`, up to 50 of them:

| Field | Values | Default |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9_-]{0,47}$`. It is the item's `source_platform`: a plugin id (`github_issues`, …), a web scraper's **name** (see below), `feedback_form`, `manual_import`, or an import source an admin defines such as `sales_csv` or `support_tickets` | — |
| `label` | Display name | — |
| `pii` | `allow` \| `redact` \| `summary_only` | `allow` |
| `retention_days` | `null` (keep forever) or 30–3650 | `null` |
| `restricted` | Hidden from users without an explicit grant | `false` |
| `dimension_defaults` | `{key: value}` applied when the message sets none ([dimensions.md](dimensions.md)) | `{}` |
| `tags` | Added to every item of the source | `[]` |

A source with no profile gets the defaults: PII allowed, kept forever, not restricted.

**Web scrapers.** A scraper's reviews do not carry the plugin id `webscraper`: each scraper
writes its own **name** (`name` in its config; the page's host name when it has none) as
`source_platform`, so a `webscraper` profile never matches anything. To give a scraper a
profile, name the scraper in the id format (for example `trustpilot_reviews`) and create a
profile with exactly that id. A scraper whose name has spaces, capitals or dots (such as
`Shop Reviews` or `www.example.com`) cannot have a profile until it is renamed, and renaming it
changes the source of its new reviews only. **Settings → Sources** suggests the scraper names
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
    IBANs, payment cards (Luhn-checked) and IPv4/IPv6 addresses with `[EMAIL]`, `[PHONE]`,
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

A CSV upload also archives the **whole file** under `raw/csv_upload/…` before its rows are
split. That archive is never redacted and never touched by retention or erasure. To keep
personal data out of it, import a sensitive source with a source profile whose `pii` is not
`allow` and whose `retention_days` is set: such sources archive per item, after redaction,
and never as a whole file.

## Access: by category AND by source

An item is visible only if **both** of these rules admit it:

1. **The category rule.** This is unchanged; see [categories.md](categories.md).
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
  list back to the default rule (Settings → Users → Category access → "Every source that is
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

Customer data is never deleted, with one exception: the opt-in worker **`voc-retention`**
(`lambda/jobs/retention/handler.py`, in VocProcessingStack). It is the only role in the app
with a delete permission on customer data, and `lib/customer-data-deletes.test.ts` pins that.

| Mode | Trigger | Deletes |
|---|---|---|
| `retention` | Daily schedule, 04:15 UTC | Items of sources whose profile sets `retention_days`, with `date` older than the cutoff |
| `erase` | `POST /settings/erasure` (admin) | Items where `field == value`. `field` is `author`, `source_id`, `csv_row_id` or `email` (`metadata.email` / `metadata.submitter_email`); optionally limited to one `source`, which is **required** for `source_id` and `csv_row_id` (an id is unique only within its source; 400 without it) |

How it works:

- Each deleted item's `s3_raw_uri` object goes with it, every version. Removing the item
  from DynamoDB moves the aggregate counters through the aggregator's REMOVE path.
- The worker hands over to a fresh invocation of itself before its 15-minute timeout.
- `POST /settings/erasure` answers 202 `{job}`. `GET /settings/erasure` lists the newest 20
  jobs.
- The job row (`pk=JOB#erasure`) stores `value_hash`, the SHA-256 of the value. **The value
  itself is never stored or logged.** Each run also writes an audit row (`pk=AUDIT#retention`).
- `raw/csv_upload/*` whole-file archives are never touched (see the limitation above).
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

### What erasure does not reach

Retention and erasure delete **feedback items and their own per-item raw archives**, and
nothing else. Copies derived from a review before it was erased stay where they are:

| Copy | Where | What to do |
|---|---|---|
| Problem summaries and quotes inside generated persona, PRD, PR/FAQ and research documents | `voc-projects` (and its document versions) | Open the project, find the person's words, edit or regenerate the document (regeneration reads the current feedback, which no longer has the item) |
| AI assistant conversations that quoted the review | `voc-conversations`, partition of each user who asked | The user deletes the conversation (`DELETE /chat/conversations/{id}`); an admin can ask affected users to do so |
| Memories extracted from conversations or agent runs | `voc-memory` (never deleted by design) | Mark the memory forgotten in the Memory page (`/memory/{id}/forget`), which hides it from retrieval |
| Idempotency rows of the processor | `voc-idempotency` | Keyed by a hash of the message, they may cache the processor's response for up to an hour, then expire through the table's TTL (`expiration`); wait an hour, or delete the row by hand |
| Whole-file CSV / JSON upload archives | `raw/csv_upload/…`, `raw/json_upload/…` in the raw bucket | Never deletable by the worker (see the limitation above); remove the file by hand with an admin role in the S3 console, or avoid it by giving the source a retention period or a non-`allow` policy |
| Archives named before 3.06.00 for ids that were not filename-safe | `raw/<source>/…` | See the archive naming note above |

Record what you removed by hand next to the erasure job: the job row keeps only the value's
hash, so it is safe to reference.

Least-privilege grants (`lib/stacks/retention-worker.ts`):

| Resource | Allowed actions |
|---|---|
| Feedback table | `GetItem`, `Query`, `Scan`, `DeleteItem` |
| Raw bucket | `DeleteObject` and `DeleteObjectVersion` on `raw/*`, plus `ListBucketVersions` with the `raw/` prefix. An explicit **Deny** of `s3:DeleteObject*` on `raw/csv_upload/*` and `raw/json_upload/*` keeps the whole-file archives undeletable whatever the code asks |
| Aggregates table | `GetItem`, `PutItem`, `UpdateItem`, `Query` |
| KMS | Encrypt/decrypt |
| Lambda | Invoke itself |
