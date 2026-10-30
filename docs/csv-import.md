# CSV import: row identity and correcting a re-upload

An administrator imports feedback from a spreadsheet on **Data sources → New source →
Spreadsheet (CSV)** (`POST /scrapers/manual/csv-upload`, admin-only, `manual_import_handler.py`).
This page covers how each row is identified, and how a corrected file updates the rows it
imported before instead of adding them a second time (issue #411). Column mapping and
dimension columns are in [dimensions.md](dimensions.md); the source profile and its PII
policy are in [source-policies.md](source-policies.md).

## Row identity

The processor keys a stored item on `SOURCE#<source>` / `FEEDBACK#sha256("<source>:<id>")`
(`shared/feedback_keys.py`), where `<id>` is the id the CSV boundary sends. Two recipes
produce that id, chosen per row:

| Recipe | When | Id | Effect of editing the row |
|---|---|---|---|
| `csv-row-v1` | No dataset name on the upload, or the row has no `id` column value | SHA-256 of the row's content (`id`, position when there is no id, text, rating, date, author, title, url, channel) | A new id: the corrected row is stored as an **additional** record |
| `csv-row-v2` | A dataset name on the upload AND the row has an `id` | SHA-256 of `['csv-row-v2', <dataset key>, <id>]` | Same id: the stored row is **updated** after you confirm |

Both recipes stay supported indefinitely and stored rows are never re-keyed. A file can mix
both kinds of rows: those without an id always use `csv-row-v1`.

Both recipes are persisted contracts (pinned by tests): a change would re-key every row
already stored, so a new behaviour gets a new version tag instead.

## The dataset name

The **Dataset name (optional)** field names the data the file holds, for example
`Example Air reviews`. It is the uploader's deliberate choice; the file name is not used,
because two people can upload `reviews.csv`.

- Trimmed, 1 to 64 characters: letters, digits, space, `-`, `_` and `.`. Anything else is a 400.
- Matched case-insensitively with runs of spaces collapsed: `Example Air Q3` and
  `example air  q3` are one dataset (`shared/csv_datasets.py` `dataset_key`).
- Scoped to the source profile the rows are filed under (the item key includes the source):
  the same dataset name under another source is a different set of rows.
- Not available together with a Radar brand (`radar_brand`): Radar rows have no update path,
  so the API answers 400 and the form turns the field off.

## Preview, then confirm

With a dataset name, the upload is two steps:

1. **Preview changes** sends the file with `dry_run: true`. Nothing is archived or queued. The
   API reads the stored items the `csv-row-v2` rows name (`BatchGetItem` on the feedback
   table) and compares each row's content digest (`csv_content_hash`) with the stored one:

   | Count | Meaning | What the upload does |
   |---|---|---|
   | `new` | No stored item for the row | Stores it as a new record |
   | `changed` | A stored item with a different digest | Updates the stored item in place |
   | `unchanged` | A stored item with the same digest | Leaves it out |
   | `v1_rows` | A row without an id | Stores it as a new record; a later upload cannot update it |

   The answer also lists the first 50 changed rows (`changed_rows`: row number, the row's own
   id, a 160-character snippet of the stored text and of the new text) and
   `changed_rows_truncated` when there are more. The form shows the counts, tells how many
   rows cannot be updated, and lists the changes.
2. **Import and update** (or **Import** when nothing stored changes) sends the same file with
   `apply_updates: true`. The classification is done again at that moment. A real upload that
   would change stored rows WITHOUT `apply_updates` is refused with **409**, so an API caller
   cannot overwrite rows by accident either. The answer carries the same `counts`.

If a stored row cannot be read (DynamoDB leaves keys unprocessed after the retries), the upload
answers **503** rather than guessing: a changed row taken for a new one would be skipped as a
duplicate and the promised update would never happen.

## What an update changes

A confirmed changed row is queued with `csv_replace: true` (`IngestMessage`,
`shared/ingest_schemas.py`). The queue schema refuses `csv_replace` on any message that is not
a CSV upload's (`ingestion_method: csv_upload`) or that lacks a well-formed `csv_dataset` and
`csv_content_hash`, so no other producer can set it. Only such a record may overwrite a stored
item; every other record naming a stored item is still a duplicate and skipped
(`shared/csv_datasets.py` `is_csv_replace`). The processor applies it with one conditional
`update_item` (`shared/csv_updates.py`):

- **Replaced:** rating, author, title, link, review date, channel, metadata, the row's own id
  (`csv_row_id`), the digest, `source_refreshed_at`. A row without a date column keeps the
  stored review date.
- **Re-enriched when the text changed:** the text and every enriched field (category,
  sentiment, urgency, summary, …), exactly like a new row. A summary-only source stores no
  text to compare, so its changed rows are always re-enriched, and the customer's words are
  still never stored.
- **A failed model call:** like a GitHub issue refresh, the fallback enrichment never
  overwrites the stored one. Only the row's own fields are written (rating, author, link, …);
  the stored text, enrichment AND digest stay, so the row still previews as changed and a later
  confirmed upload tries the text again (after the one-hour idempotency window of that exact
  correction).
- **Kept:** a category a person corrected (`category_source: manual`), locked dimensions,
  tags, the item keys and the import date. Dimension and tag COLUMNS of the file are not
  applied to a stored row, and are not part of the digest.
- **Guarded:** the update lands only if the stored item was stored by the SAME dataset (its
  `csv_dataset` equals the record's, so a replace that merely shares a key with a non-CSV item
  writes nothing) and the stored digest (and, when re-enriched, the dimensions and the
  category's manual flag) is still what was read; a failed condition is retried by SQS against
  the current state and ends in the DLQ when it can never hold.
- **Metrics:** the item keeps its import day, so the aggregator moves the counters of the
  stream's MODIFY on that day (category, sentiment, urgency, channel), as for an in-place GitHub
  issue refresh ([processing-pipeline.md](processing-pipeline.md)).
- **Raw archive:** under a retention period (per-item archives) the new copy is written over the
  stored item's own archive key, so the item keeps one archive that retention deletes with it.
  A kept-forever source archives the whole new file under `raw/csv_upload/…` as before.
- **Idempotency:** the correction's key is `<source>:<id>:csv:<digest>`, so the first import's
  idempotency record does not swallow it, while a redelivery of the same correction does.

## The content digest and PII

`csv_content_hash` is one function, `shared/csv_content_digest.py` `csv_row_digest`, called by
the manual-import API for both the preview and the upload; the processor stores the digest the
message carries.

- **`allow` source:** a sha256 of the file's own values (`csv-content-v1`).
- **`redact` / `summary_only` source:** a sha256 of the values AFTER the source policy
  (`csv-content-policed-v1`): author dropped, text, title, link and metadata redacted, exactly
  what the policy stores. A digest of the original values would let anyone who can read it
  confirm a guess of the withheld PII (an email, a name).

Why not a keyed HMAC: no secret reaches both the manual-import Lambda and the processor
without new infrastructure (the customer-managed KMS key is an encryption key, not an HMAC
key; neither Lambda reads a Secrets Manager value), so hashing what is stored needs no new
secret and no new IAM. **Trade-off:** a correction that changes ONLY redacted PII (an email
address, a phone number, the author's name) previews as unchanged and is not applied, because
nothing that is stored would change. CSV messages carry no language, so the redaction is the
deterministic pattern set (`shared/pii_redaction.py`).

## Decisions (issue #411)

1. The namespace is an explicit, optional dataset name, not the file name.
2. `csv-row-v2` applies only to rows with an id under a dataset name; everything else keeps
   `csv-row-v1` exactly, and nothing stored is migrated.
3. Reusing a dataset with different content is a visible update: a preview first, then an
   explicit confirmation (`apply_updates`); unchanged rows are skipped.
4. The form says how many rows cannot be updated later (no id, or no dataset name).

## Not covered

- JSON upload (`/scrapers/manual/json-upload`, also the assistant's `import_reviews` tool) is
  unchanged: its items carry their own ids and an existing id is a duplicate.
- Deleting rows that are missing from the corrected file: an upload never deletes.
