"""What the retention / erasure worker deletes, and how (``jobs/retention/handler.py``).

The ONLY code path in the platform that deletes customer feedback. It runs in
two opt-in modes and nothing else may call it:

- ``retention``: items of a source whose profile sets ``retention_days`` and
  whose ``date`` is older than that many days.
- ``erase``: items whose ``author`` / ``source_id`` / ``csv_row_id`` equals a
  value, or whose ``metadata.email`` / ``metadata.submitter_email`` does —
  optionally within one source.

An item is removed with DeleteItem (the aggregator's stream REMOVE path moves
its counters) and its per-item raw archive (every version) is removed with it.
A raw object is deleted only when it is that item's OWN archive: under
``raw/``, in the configured bucket, outside the whole-upload archives
(``raw/csv_upload/``, ``raw/json_upload/``), and named after the item's
``source_id`` the way every per-item archive is (``plugins/_shared/raw_archive``,
``shared/ingest_archive``). A whole-file archive shared by many items never
matches, so it is never touched (documented limitation: those sources keep
their uploaded files; give them a retention period or a non-allow policy so
they archive per item).

The erased value is never stored or logged: jobs and audit rows carry its
SHA-256 (``value_hash``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.archive_keys import archive_key_stem
from shared.logging import logger

__all__ = [
    'ERASE_FIELDS',
    'delete_item',
    'erase_filter',
    'item_raw_key',
    'retention_cutoffs',
    'retention_filter',
    'value_hash',
]

ERASE_FIELDS: Final = ('author', 'source_id', 'csv_row_id', 'email')
_EMAIL_PATHS: Final = ('metadata.email', 'metadata.submitter_email')
_FEEDBACK_SK_PREFIX: Final = 'FEEDBACK#'
_RAW_PREFIX: Final = 'raw/'
_WHOLE_UPLOAD_PREFIXES: Final = ('raw/csv_upload/', 'raw/json_upload/')
_MAX_VERSIONS_PER_DELETE: Final = 1000


def value_hash(value: str) -> str:
    """The SHA-256 hex digest an erasure job records instead of the value."""
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def retention_cutoffs(profiles: list[dict[str, Any]], today: date) -> dict[str, str]:
    """``{source_id: first kept 'YYYY-MM-DD'}`` for every profile with a retention period."""
    cutoffs: dict[str, str] = {}
    for profile in profiles:
        days = profile.get('retention_days')
        if isinstance(days, int) and not isinstance(days, bool) and days > 0:
            cutoffs[str(profile['id'])] = (today - timedelta(days=days)).isoformat()
    return cutoffs


def _feedback_items() -> ConditionBase:
    return Attr('sk').begins_with(_FEEDBACK_SK_PREFIX)


def retention_filter(cutoffs: Mapping[str, str]) -> ConditionBase:
    """Scan filter: feedback items of a retained source dated before its cutoff."""
    clauses = [Attr('source_platform').eq(source) & Attr('date').lt(cutoff) for source, cutoff in cutoffs.items()]
    if not clauses:
        raise ValueError('retention_filter needs at least one source')
    combined = clauses[0]
    for clause in clauses[1:]:
        combined = combined | clause
    return _feedback_items() & combined


def erase_filter(field: str, value: str, source: str | None) -> ConditionBase:
    """Scan filter: feedback items whose ``field`` equals ``value`` (optionally in one source)."""
    if field not in ERASE_FIELDS:
        raise ValueError(f'Unknown erasure field "{field}"')
    if field == 'email':
        # Case-insensitive: ingestion stores these lower-cased; the value as typed
        # also matches an item stored before that normalisation.
        spellings = list(dict.fromkeys([value.strip().lower(), value]))
        match = Attr(_EMAIL_PATHS[0]).is_in(spellings) | Attr(_EMAIL_PATHS[1]).is_in(spellings)
    else:
        match = Attr(field).eq(value)
    condition = _feedback_items() & match
    return condition & Attr('source_platform').eq(source) if source else condition



def item_raw_key(item: Mapping[str, Any], bucket: str) -> str | None:
    """The key of ``item``'s own per-item raw archive in ``bucket``, or None (see module doc)."""
    uri = item.get('s3_raw_uri')
    source_id = item.get('source_id')
    if not isinstance(uri, str) or not bucket or not isinstance(source_id, str) or not source_id:
        return None
    parsed = urlparse(uri)
    key = parsed.path.lstrip('/')
    if parsed.scheme != 's3' or parsed.netloc != bucket or not key.startswith(_RAW_PREFIX):
        return None
    if key.startswith(_WHOLE_UPLOAD_PREFIXES) or '..' in key.split('/'):
        return None
    stem = key.rsplit('/', 1)[-1].removesuffix('.json')
    # The writers' collision-free stem only (see shared/archive_keys.py).
    return key if stem == archive_key_stem(source_id) else None


def _delete_all_versions(s3: Any, bucket: str, key: str) -> bool:
    """Delete every version and delete marker of exactly ``key``; True when any existed."""
    deleted = False
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=key):
        versions = [
            {'Key': entry['Key'], 'VersionId': entry['VersionId']}
            for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])]
            if entry.get('Key') == key and entry.get('VersionId')
        ]
        for start in range(0, len(versions), _MAX_VERSIONS_PER_DELETE):
            response = s3.delete_objects(
                Bucket=bucket, Delete={'Objects': versions[start:start + _MAX_VERSIONS_PER_DELETE], 'Quiet': True})
            if response.get('Errors'):
                raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
            deleted = True
    return deleted


def delete_item(feedback_table: Any, s3: Any, bucket: str, item: Mapping[str, Any]) -> tuple[int, int]:
    """Delete one feedback item and its own raw archive; ``(items deleted, objects deleted)``.

    The raw archive goes first: if that fails the item stays, so a retry finds
    it again (deleting the item first would orphan the object for good).
    """
    objects = 0
    key = item_raw_key(item, bucket)
    if key is not None and _delete_all_versions(s3, bucket, key):
        objects = 1
    feedback_table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    logger.debug('Deleted one feedback item under its retention / erasure rule')
    return 1, objects
