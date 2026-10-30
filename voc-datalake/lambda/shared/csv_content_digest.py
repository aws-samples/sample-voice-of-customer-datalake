"""The ``csv_content_hash`` of a CSV dataset row under its source's PII policy (issue #411).

ONE function computes the digest a ``csv-row-v2`` row is stored and compared with; the
manual-import API calls it for both the preview (``dry_run``) and the real upload, and the
processor stores exactly the digest the message carries.

* ``allow``: the file's own values (``CSV_CONTENT_VERSION``), as before.
* ``redact`` / ``summary_only``: the values AFTER ``shared.source_policy.apply_source_policy``
  (author dropped, text / title / URL / metadata redacted; ``CSV_CONTENT_POLICED_VERSION``).
  A digest of the pre-policy values would let anyone holding it confirm a guess of the
  withheld PII. No deployment secret reaches both Lambdas without new infrastructure (the
  customer-managed KMS key is an encryption key, not an HMAC key), so the digest covers only
  what is stored. Trade-off: a correction that changes ONLY redacted PII (an email, a phone
  number, the author) reads as unchanged and is not applied. docs/csv-import.md.

Redaction of a CSV row is deterministic: CSV messages carry no ``language``, so only the
regex patterns run (``shared.pii_redaction``; Comprehend needs a language).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shared.csv_datasets import CSV_CONTENT_POLICED_VERSION, csv_content_hash
from shared.source_policy import apply_source_policy, raw_archive_allowed

__all__ = ['csv_row_digest']

#: The fields the source policy rewrites; the others (rating, date, channel) pass unchanged.
_POLICED_FIELDS = ('text', 'author', 'title', 'url', 'metadata')


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
    return csv_content_hash(_policed(fields, profile), CSV_CONTENT_POLICED_VERSION)
