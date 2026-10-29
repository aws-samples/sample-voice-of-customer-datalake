"""What the retention / erasure worker deletes, and how (``jobs/retention/handler.py``).

The ONLY code path in the platform that deletes customer feedback. It runs in
two opt-in modes and nothing else may call it:

- ``retention``: items of a source whose profile sets ``retention_days`` and
  whose ``date`` is older than that many days.
- ``erase``: items whose ``author`` / ``source_id`` / ``csv_row_id`` equals a
  value, or whose ``metadata.email`` / ``metadata.submitter_email`` does —
  optionally within one source. ``field = 'source'`` is the whole-source
  erasure: every item whose ``source_platform`` is the value, then every
  remaining object under ``raw/{source}/`` (``raw_source_prefix``,
  ``delete_raw_prefix_page``), so orphaned archives go too.

A whole-source erasure matches on ``source_platform``, never on the partition
key: an item's ``pk`` is ``SOURCE#{brand_name or source_platform}``
(``processor/handler.py``), so a deployment with a brand name keeps every
plugin's items in ONE brand partition, and a feedback form keeps its own
brand's. Querying ``pk = SOURCE#{source}`` would miss those items, and the
partition alone cannot tell sources apart, so the worker scans with the
``source_platform`` filter exactly like the retention mode does.

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
SHA-256 (``value_hash``, ``shared.digests.sha256_hex``).
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.archive_keys import archive_key_stem
from shared.logging import logger

__all__ = [
    'delete_item',
    'delete_raw_prefix_page',
    'erase_filter',
    'raw_source_prefix',
    'retention_cutoffs',
    'retention_filter',
]

# The whole-source erasure's field: the value IS a source id (``source_platform``).
SOURCE_FIELD: Final = 'source'
ERASE_FIELDS: Final = ('author', 'source_id', 'csv_row_id', 'email', SOURCE_FIELD)
# The partition of erasure job rows in voc-aggregates (Settings starts them, voc-retention runs them).
ERASURE_JOB_PK: Final = 'JOB#erasure'
_EMAIL_PATHS: Final = ('metadata.email', 'metadata.submitter_email')
_FEEDBACK_SK_PREFIX: Final = 'FEEDBACK#'
RAW_PREFIX: Final = 'raw/'
_WHOLE_UPLOAD_PREFIXES: Final = ('raw/csv_upload/', 'raw/json_upload/')
_MAX_VERSIONS_PER_DELETE: Final = 1000


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
    elif field == SOURCE_FIELD:
        match = Attr('source_platform').eq(value)
    else:
        match = Attr(field).eq(value)
    condition = _feedback_items() & match
    return condition & Attr('source_platform').eq(source) if source and field != SOURCE_FIELD else condition


def item_raw_key(item: Mapping[str, Any], bucket: str) -> str | None:
    """The key of ``item``'s own per-item raw archive in ``bucket``, or None (see module doc)."""
    uri = item.get('s3_raw_uri')
    source_id = item.get('source_id')
    if not isinstance(uri, str) or not bucket or not isinstance(source_id, str) or not source_id:
        return None
    parsed = urlparse(uri)
    key = parsed.path.lstrip('/')
    if parsed.scheme != 's3' or parsed.netloc != bucket or not key.startswith(RAW_PREFIX):
        return None
    if key.startswith(_WHOLE_UPLOAD_PREFIXES) or '..' in key.split('/'):
        return None
    stem = key.rpartition('/')[2].removesuffix('.json')
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


def raw_source_prefix(source: str) -> str | None:
    """``raw/{source}/``: every per-item archive of ``source``; None for a whole-upload archive folder.

    The trailing ``/`` keeps source ``web`` from matching the folder of ``web_shop``. A
    source id never contains ``/`` (``SOURCE_ID_RE``), so no other folder can
    be reached from it.
    """
    if not source or '/' in source or source in ('.', '..'):
        return None
    prefix = f'{RAW_PREFIX}{source}/'
    return None if prefix.startswith(_WHOLE_UPLOAD_PREFIXES) else prefix


def delete_raw_prefix_page(s3: Any, bucket: str, prefix: str) -> tuple[int, bool]:
    """Delete the first listing page (≤ 1,000 versions) under ``prefix``: ``(objects deleted, more left)``.

    Every version and delete marker goes, as for one item's archive. The count
    is of distinct objects (the one latest entry of each key in the page). No
    listing cursor is kept: what was listed is deleted, so the next call lists
    from the start of the prefix again and sees only what is left (a marker
    naming a version just deleted is not a reliable place to resume from).
    """
    page = s3.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=_MAX_VERSIONS_PER_DELETE)
    entries = [entry for entry in [*page.get('Versions', []), *page.get('DeleteMarkers', [])]
               if str(entry.get('Key', '')).startswith(prefix) and entry.get('VersionId')]
    if entries:
        response = s3.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': entry['Key'], 'VersionId': entry['VersionId']} for entry in entries], 'Quiet': True})
        if response.get('Errors'):
            raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
    objects = sum(1 for entry in entries if entry.get('IsLatest'))
    return objects, bool(entries) and bool(page.get('IsTruncated'))
