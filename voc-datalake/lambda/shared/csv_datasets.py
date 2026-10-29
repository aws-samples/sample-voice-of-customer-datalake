"""CSV dataset identity (``csv-row-v2``): a corrected re-upload updates the stored row (issue #411).

``csv-row-v1`` (manual_import_handler ``CSV_ROW_ID_FIELDS``) fingerprints a row's CONTENT,
so correcting a typo gives the row a new identity and a re-upload stores it twice. A row
that has its own ``id`` column value AND is uploaded under a dataset name the admin types
is keyed by those two instead, so its identity survives an edit:

    sha256(json(['csv-row-v2', <normalised dataset name>, <the row's id>]))[:32]

Rows without an ``id``, and every upload without a dataset name, keep ``csv-row-v1``
exactly as before. Both recipes stay supported per row; stored rows are never re-keyed.

The dataset name is the uploader's deliberate choice (not the file name: two people
upload ``reviews.csv``). It is trimmed, 1 to 64 characters of letters, digits, space,
``-``, ``_`` and ``.``, and matched case-insensitively with runs of spaces collapsed,
so ``Example Air Q3`` and ``example air  q3`` are one dataset.

Whether a re-uploaded row changed is decided by ``csv_content_hash``: a digest of the
fields an update can change, computed from the file's own values (before any source
policy), stored on the item and compared at the next upload. Dimension and tag columns
are not part of it and an update never changes them (a person may have corrected them).

A row the uploader CONFIRMED as changed is queued with ``csv_replace: true``; only such a
record may overwrite a stored item (``is_csv_replace``, read by the processor). Every
other CSV record that names a stored item is still a duplicate and skipped.

BOTH RECIPES ARE PERSISTED CONTRACTS: add a version tag, never edit one.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from typing import Any, Final

__all__ = [
    'CSV_CONTENT_FIELDS',
    'CSV_CONTENT_VERSION',
    'CSV_INGESTION_METHOD',
    'CSV_ROW_ID_V2',
    'DATASET_NAME_MAX_LENGTH',
    'csv_content_hash',
    'csv_row_id_v2',
    'dataset_key',
    'is_csv_replace',
]

CSV_ROW_ID_V2: Final = 'csv-row-v2'
CSV_CONTENT_VERSION: Final = 'csv-content-v1'
DATASET_NAME_MAX_LENGTH: Final = 64
_DATASET_NAME_RE: Final = re.compile(r'^[A-Za-z0-9 ._-]+\Z')
_SPACES: Final = re.compile(r' +')
_HASH_LENGTH: Final = 32

#: What a confirmed update may change on a stored row, in hash order (a persisted contract).
CSV_CONTENT_FIELDS: Final = ('text', 'rating', 'created_at', 'author', 'title', 'url', 'channel', 'metadata')

#: The ingestion method of a CSV upload's messages (manual_import_handler ``_csv_message``).
CSV_INGESTION_METHOD: Final = 'csv_upload'


def dataset_key(raw: object) -> str | None:
    """The normalised dataset key of an upload's ``dataset_name``; None when none was given.

    Raises ``ValueError`` (the caller answers 400) for a value that is not a valid name.
    """
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError('dataset_name must be a string')
    name = raw.strip()
    if not name:
        return None
    if len(name) > DATASET_NAME_MAX_LENGTH:
        raise ValueError(f'dataset_name must be at most {DATASET_NAME_MAX_LENGTH} characters')
    if not _DATASET_NAME_RE.match(name):
        raise ValueError('dataset_name may contain only letters, digits, spaces, "-", "_" and "."')
    return _SPACES.sub(' ', name).casefold()


def _digest(parts: list[Any]) -> str:
    payload = json.dumps(parts, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()[:_HASH_LENGTH]


def csv_row_id_v2(dataset: str, source_id: str) -> str:
    """The ``csv-row-v2`` identity of the row whose own id is ``source_id`` in dataset ``dataset`` (normalised)."""
    return _digest([CSV_ROW_ID_V2, dataset, source_id])


def csv_content_hash(fields: Mapping[str, Any]) -> str:
    """A digest of a row's updatable content (``CSV_CONTENT_FIELDS``; KeyError when one is missing)."""
    return _digest([CSV_CONTENT_VERSION, *(fields[name] for name in CSV_CONTENT_FIELDS)])


def is_csv_replace(raw_record: Mapping[str, Any]) -> bool:
    """True for a CSV record the uploader confirmed as an update of the row it names."""
    return (raw_record.get('csv_replace') is True
            and raw_record.get('ingestion_method') == CSV_INGESTION_METHOD
            and bool(raw_record.get('csv_dataset'))
            and bool(raw_record.get('csv_content_hash')))
