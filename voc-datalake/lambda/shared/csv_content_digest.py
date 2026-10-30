"""The ``csv_content_hash`` of a CSV dataset row under its source's PII policy (issue #411).

ONE function computes the digest a ``csv-row-v2`` row is stored and compared with; the
manual-import API calls it for both the preview (``dry_run``) and the real upload, and the
processor stores exactly the digest the message carries.

The digest covers only what the item stores, so the stored digest can never confirm a guess
of something the policy withholds:

* ``allow``: the file's own values (``CSV_CONTENT_VERSION``), as before.
* ``redact``: the values AFTER ``shared.source_policy.apply_source_policy`` (author dropped,
  text / title / URL / metadata redacted; ``CSV_CONTENT_POLICED_VERSION``). Trade-off: a
  correction that changes ONLY redacted PII (an email, a phone number, the author) reads as
  unchanged and is not applied.
* ``summary_only``: the item stores no text, author, title or metadata (only the model's
  summary), so they are left out and only rating, review date, channel and the policed link
  count (``CSV_CONTENT_SUMMARY_VERSION``). A digest of the (regex-redacted) text would let
  anyone who can read the item confirm a guess of the customer's full wording, which the
  policy deliberately never stores. Trade-off: a correction of only the text, title, author or
  metadata reads as unchanged; a changed row is re-enriched from the file's current text.

No deployment secret reaches both Lambdas without new infrastructure (the customer-managed
KMS key is an encryption key, not an HMAC key), hence no keyed digest. docs/csv-import.md.

Redaction of a CSV row is deterministic: CSV messages carry no ``language``, so only the
regex patterns run (``shared.pii_redaction``; Comprehend needs a language).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.csv_datasets import CSV_CONTENT_POLICED_VERSION, CSV_CONTENT_SUMMARY_VERSION, csv_content_hash
from shared.source_policy import apply_source_policy, raw_archive_allowed
from shared.source_profiles import PII_SUMMARY_ONLY

__all__ = ['csv_row_digest']

#: The fields the source policy rewrites; the others (rating, date, channel) pass unchanged.
_POLICED_FIELDS: Final = ('text', 'author', 'title', 'url', 'metadata')
#: The fields a summary-only item does not store (``shared.csv_updates`` writes them as None).
_SUMMARY_ONLY_UNSTORED: Final = ('text', 'author', 'title', 'metadata')


def _policed(fields: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any]:
    """``fields`` as the source policy stores them (a dropped field reads None)."""
    message = {name: fields[name] for name in _POLICED_FIELDS}
    # None only when no text is left to redact: nothing of the row's words is stored, so none is hashed.
    out = apply_source_policy(message, profile) or {}
    return {**fields, **{name: out.get(name) for name in _POLICED_FIELDS}}


def csv_row_digest(fields: Mapping[str, Any], profile: Mapping[str, Any]) -> str:
    """The digest of a row's updatable content (``CSV_CONTENT_FIELDS``) under the source ``profile``.

    ``profile`` is the one the upload applies (``shared.ingest_archive.upload_profile``), judged by
    the same rule as ``apply_source_policy`` (an unknown ``pii`` value is ``allow``).
    """
    if raw_archive_allowed(profile):
        return csv_content_hash(fields)
    policed = _policed(fields, profile)
    if profile.get('pii') == PII_SUMMARY_ONLY:
        return csv_content_hash({**policed, **dict.fromkeys(_SUMMARY_ONLY_UNSTORED)}, CSV_CONTENT_SUMMARY_VERSION)
    return csv_content_hash(policed, CSV_CONTENT_POLICED_VERSION)
