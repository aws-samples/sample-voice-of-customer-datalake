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
its counters) and its per-item raw archive is removed with it, in BOTH layouts
(``shared/raw_versions.py``): every version of the legacy object
``raw/{source}/{y}/{m}/{d}/{stem}.json`` and every object (all versions, all
delete markers) under the item's folder ``raw/{source}/{y}/{m}/{d}/{stem}/``,
whichever of the two its ``s3_raw_uri`` names. A raw object is deleted only
when it is that item's OWN archive: under ``raw/``, in the configured bucket,
outside the whole-upload archives (``raw/csv_upload/``, ``raw/json_upload/``),
and named after the item's ``source_id`` the way every per-item archive is
(``plugins/_shared/raw_archive``, ``shared/ingest_archive``). An API-side item
received again on a later day (a new ingest-date folder) leaves its older folder
to the whole-source erasure; a correction (CSV dataset update) writes into the
stored item's own folder, so it goes with the item. A whole-file archive shared by many items
(``raw/csv_upload/``, ``raw/json_upload/``) is never an item's own archive. Every row of
one such file is filed under the one source its upload named, so a whole-source
erasure deletes the file (every version, ``delete_whole_upload``); any other erasure
or retention run leaves it and lists it on its job / audit row as a file needing
review (keys only), because rewriting it without the erased rows would mean
re-parsing a CSV whose column mapping is not stored.

Every kept Silver version of a deleted item (``silver/{source}/{feedback_id}/``, the
item's earlier states, ``shared/silver_provenance.py``) goes with it, every object
version (``delete_silver_versions``); a whole-source erasure also sweeps what is left
under ``silver/{source}/`` (``silver_source_prefix``).

The same filters and deletes reach Radar (``voc-radar``: other brands' reviews,
``STORE_RADAR``): a review, its dedupe marker and its own raw archive.

The erased value is never stored or logged: jobs and audit rows carry its
SHA-256 (``value_hash``, ``shared.digests.sha256_hex``).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Final
from urllib.parse import urlparse

from boto3.dynamodb.conditions import Attr, ConditionBase

from shared.archive_keys import archive_key_stem
from shared.logging import logger
from shared.radar_store import marker_key
from shared.raw_versions import RAW_PREFIX, parse_item_key
from shared.silver_provenance import SILVER_PREFIX, silver_item_prefix

__all__ = [
    'ERASURE_JOB_COUNTERS',
    'FEEDBACK_SK_PREFIX',
    'STORE_FEEDBACK',
    'STORE_RADAR',
    'delete_item',
    'delete_radar_item',
    'delete_raw_prefix_page',
    'delete_whole_upload',
    'erase_filter',
    'raw_source_prefix',
    'retention_cutoffs',
    'retention_filter',
    'silver_source_prefix',
    'whole_upload_key',
]

# The whole-source erasure's field: the value IS a source id (``source_platform``).
SOURCE_FIELD: Final = 'source'
ERASE_FIELDS: Final = ('author', 'source_id', 'csv_row_id', 'email', SOURCE_FIELD)
# The partition of erasure job rows in voc-aggregates (Settings starts them, voc-retention runs them).
ERASURE_JOB_PK: Final = 'JOB#erasure'
# Every job row's ``sk`` (and ``job_id``) starts with this; the partition's lock rows do not.
ERASURE_JOB_PREFIX: Final = 'er_'
_EMAIL_PATHS: Final = ('metadata.email', 'metadata.submitter_email')
FEEDBACK_SK_PREFIX: Final = 'FEEDBACK#'
# The counters an erasure job's row records (voc-retention writes them, Settings lists them; 0 when absent).
ERASURE_JOB_COUNTERS: Final = ('deleted_items', 'deleted_objects', 'deleted_radar_items', 'artifacts_marked')
# Where a matched item lives: voc-feedback, or voc-radar (another brand's review, docs/radar.md).
STORE_FEEDBACK: Final = 'feedback'
STORE_RADAR: Final = 'radar'
_RADAR_PK_PREFIX: Final = 'RADAR#'
_RADAR_ITEMS_MARK: Final = '#ITEMS#'
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


def _store_items(store: str) -> ConditionBase:
    """The rows of ``store`` that are reviews: ``FEEDBACK#`` items, or Radar's month-partitioned reviews.

    A Radar review row (``shared/radar_store.py``) is ``RADAR#{brand}#ITEMS#{month}`` and carries
    ``feedback_id`` and ``radar_brand``; its counters and dedupe markers carry neither, so a
    category named ``ITEMS`` in a counter's key can never match.
    """
    if store == STORE_RADAR:
        return (Attr('pk').begins_with(_RADAR_PK_PREFIX) & Attr('pk').contains(_RADAR_ITEMS_MARK)
                & Attr('feedback_id').exists() & Attr('radar_brand').exists())
    if store != STORE_FEEDBACK:
        raise ValueError(f'Unknown item store "{store}"')
    return Attr('sk').begins_with(FEEDBACK_SK_PREFIX)


def retention_filter(cutoffs: Mapping[str, str], store: str = STORE_FEEDBACK) -> ConditionBase:
    """Scan filter: items of ``store`` of a retained source dated before its cutoff."""
    clauses = [Attr('source_platform').eq(source) & Attr('date').lt(cutoff) for source, cutoff in cutoffs.items()]
    if not clauses:
        raise ValueError('retention_filter needs at least one source')
    combined = clauses[0]
    for clause in clauses[1:]:
        combined = combined | clause
    return _store_items(store) & combined


def erase_filter(field: str, value: str, source: str | None, store: str = STORE_FEEDBACK) -> ConditionBase:
    """Scan filter: items of ``store`` whose ``field`` equals ``value`` (optionally in one source)."""
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
    condition = _store_items(store) & match
    return condition & Attr('source_platform').eq(source) if source and field != SOURCE_FIELD else condition


@dataclass(frozen=True)
class ItemRawObjects:
    """One item's own raw objects: an exact key (its legacy archive) and, in the versioned layout, its folder."""

    key: str
    folder: str | None


def _own_raw_key(item: Mapping[str, Any], bucket: str) -> tuple[str, str] | None:
    """``(key, source_id)`` of ``item``'s ``s3_raw_uri`` when it may be its own archive (see module doc)."""
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
    return key, source_id


def item_raw_objects(item: Mapping[str, Any], bucket: str) -> ItemRawObjects | None:
    """``item``'s own raw objects in ``bucket`` in BOTH layouts, or None (see module doc).

    A per-item archive key (``shared.raw_versions.parse_item_key``), legacy
    ``.../{stem}.json`` or versioned ``.../{stem}/{sha16}.json``, names the legacy key
    AND the folder holding every version, whichever of the two the item references.
    Any other key under ``raw/`` whose file stem is the item's is that exact key only,
    as before. The stem must be the writers' collision-free one (``shared/archive_keys.py``).
    """
    own = _own_raw_key(item, bucket)
    if own is None:
        return None
    key, source_id = own
    stem = archive_key_stem(source_id)
    archive = parse_item_key(key)
    if archive is not None:
        return ItemRawObjects(key=archive.legacy_key, folder=archive.folder) if archive.stem == stem else None
    return ItemRawObjects(key=key, folder=None) if key.rpartition('/')[2].removesuffix('.json') == stem else None


def _delete_versions(s3: Any, bucket: str, prefix: str, matches: Callable[[str], bool]) -> int:
    """Delete every version and delete marker under ``prefix`` whose key ``matches``; the files deleted.

    The count is of distinct keys that still had a version holding data (a delete
    marker alone is no file).
    """
    files: set[str] = set()
    paginator = s3.get_paginator('list_object_versions')
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        data = [entry for entry in page.get('Versions', []) if _selected(entry, matches)]
        markers = [entry for entry in page.get('DeleteMarkers', []) if _selected(entry, matches)]
        versions = [{'Key': entry['Key'], 'VersionId': entry['VersionId']} for entry in [*data, *markers]]
        for start in range(0, len(versions), _MAX_VERSIONS_PER_DELETE):
            response = s3.delete_objects(
                Bucket=bucket, Delete={'Objects': versions[start:start + _MAX_VERSIONS_PER_DELETE], 'Quiet': True})
            if response.get('Errors'):
                raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
        files.update(str(entry['Key']) for entry in data)
    return len(files)


def _selected(entry: Mapping[str, Any], matches: Callable[[str], bool]) -> bool:
    return matches(str(entry.get('Key', ''))) and bool(entry.get('VersionId'))


def _delete_own_raw_objects(s3: Any, bucket: str, item: Mapping[str, Any]) -> int:
    """Every version of ``item``'s own raw archive, in both layouts; the files deleted."""
    targets = item_raw_objects(item, bucket)
    if targets is None:
        return 0
    legacy = targets.key
    objects = _delete_versions(s3, bucket, legacy, lambda key: key == legacy)
    folder = targets.folder
    if folder is not None:
        objects += _delete_versions(s3, bucket, folder, lambda key: key.startswith(folder))
    return objects


def delete_item(feedback_table: Any, s3: Any, bucket: str, item: Mapping[str, Any]) -> tuple[int, int]:
    """Delete one feedback item and its own raw objects; ``(items deleted, raw files deleted)``.

    Every version of the legacy key and every object (all versions) under the item's
    folder go, and every kept Silver version of the item (``delete_silver_versions``).
    The S3 copies go first: if that fails the item stays, so a retry finds
    it again (deleting the item first would orphan the objects for good).
    """
    objects = delete_silver_versions(s3, bucket, item) + _delete_own_raw_objects(s3, bucket, item)
    feedback_table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    logger.debug('Deleted one feedback item under its retention / erasure rule')
    return 1, objects


def delete_silver_versions(s3: Any, bucket: str, item: Mapping[str, Any]) -> int:
    """Every kept Silver version of ``item`` (``silver/{source}/{feedback_id}/``, all object versions).

    The item's earlier states (``shared/silver_provenance.py``) are copies of it, so an erasure
    reaches them too (TENETS.md D5). Returns the files deleted; 0 for an item without an id.
    """
    prefix = silver_item_prefix(item)
    if prefix is None:
        return 0
    return _delete_versions(s3, bucket, prefix, lambda key: key.startswith(prefix))


def delete_radar_item(radar_table: Any, s3: Any, bucket: str, item: Mapping[str, Any]) -> tuple[int, int]:
    """Delete one Radar review, its dedupe marker and its own raw objects; ``(reviews, raw files)``.

    Same order as ``delete_item``: raw first, then the marker, then the review row, so
    a crash leaves the review findable by the next scan (a marker left without its row
    would only keep that review from being stored again). The brand's daily counters
    are left as they are: they hold counts, no content, and are rebuilt from the
    reviews (docs/radar.md).
    """
    objects = _delete_own_raw_objects(s3, bucket, item)
    radar_table.delete_item(Key=marker_key(str(item['radar_brand']), str(item['feedback_id'])))
    radar_table.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    logger.debug('Deleted one Radar review under its retention / erasure rule')
    return 1, objects


def whole_upload_key(item: Mapping[str, Any], bucket: str) -> str | None:
    """The key of the whole-file upload (``raw/csv_upload/``, ``raw/json_upload/``) ``item`` came from, or None.

    Such a file holds every row of one CSV / JSON upload, all filed under the one
    source the upload named (``api/manual_import_handler.py``), so only a
    whole-source erasure of that source may delete it (``delete_whole_upload``).
    """
    uri = item.get('s3_raw_uri')
    if not isinstance(uri, str) or not bucket:
        return None
    parsed = urlparse(uri)
    key = parsed.path.lstrip('/')
    if parsed.scheme != 's3' or parsed.netloc != bucket or '..' in key.split('/'):
        return None
    return key if key.startswith(_WHOLE_UPLOAD_PREFIXES) and not key.endswith('/') else None


def delete_whole_upload(s3: Any, bucket: str, key: str) -> int:
    """Every version of the whole-file upload at exactly ``key``; the files deleted (0 or 1)."""
    if not key.startswith(_WHOLE_UPLOAD_PREFIXES):
        raise ValueError('Not a whole-file upload archive')
    return _delete_versions(s3, bucket, key, lambda listed: listed == key)


def silver_source_prefix(source: str) -> str | None:
    """``silver/{source}/``: every kept Silver version of ``source``'s items (same rules as ``raw_source_prefix``)."""
    if not source or '/' in source or source in ('.', '..'):
        return None
    return f'{SILVER_PREFIX}{archive_key_stem(source)}/'


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
    is of files: the distinct keys in the page that still had a version holding
    data (a delete marker alone is no file, so it never counts). No
    listing cursor is kept: what was listed is deleted, so the next call lists
    from the start of the prefix again and sees only what is left (a marker
    naming a version just deleted is not a reliable place to resume from).
    """
    page = s3.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=_MAX_VERSIONS_PER_DELETE)
    versions = [entry for entry in page.get('Versions', []) if _under(entry, prefix)]
    entries = [*versions, *(entry for entry in page.get('DeleteMarkers', []) if _under(entry, prefix))]
    if entries:
        response = s3.delete_objects(Bucket=bucket, Delete={
            'Objects': [{'Key': entry['Key'], 'VersionId': entry['VersionId']} for entry in entries], 'Quiet': True})
        if response.get('Errors'):
            raise RuntimeError(f'{len(response["Errors"])} raw object versions could not be deleted')
    objects = len({entry['Key'] for entry in versions})
    return objects, bool(entries) and bool(page.get('IsTruncated'))


def _under(entry: Mapping[str, Any], prefix: str) -> bool:
    """A listed version / marker under ``prefix`` that names a version id (what DeleteObjects needs)."""
    return str(entry.get('Key', '')).startswith(prefix) and bool(entry.get('VersionId'))
