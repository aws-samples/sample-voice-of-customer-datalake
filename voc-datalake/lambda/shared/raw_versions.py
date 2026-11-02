"""Write-once, versioned per-item raw archive keys and the one conditional put every raw writer uses.

The bronze layer (``raw/``) keeps history: nothing under it is overwritten or expired
(TENETS.md D1). An item received again with different content is a NEW object next
to the old one, in the item's own folder::

    raw/{source}/{YYYY}/{MM}/{DD}/{stem}/{sha16}.json

- ``{stem}``: the item's collision-free file stem (``shared.archive_keys.archive_key_stem``),
  a folder holding every version of the item.
- ``{sha16}``: the first 16 hex characters of the SHA-256 of the canonical JSON of the
  item's CONTENT (``content_digest``; never a timestamp), so a re-ingest of identical
  content maps to the same key and writes nothing new.

Every write sends ``If-None-Match: *`` (``put_raw_version``): S3 answers 412
``PreconditionFailed`` when the key exists, which here means "this exact content is
already archived" and is a success; 409 ``ConditionalRequestConflict`` (a concurrent
write of the same key) is retried once. The raw bucket's policy denies any PutObject
under ``raw/`` without that header (``lib/stacks/core-buckets.ts``).

Archives written before this layout (``raw/{source}/{YYYY}/{MM}/{DD}/{stem}.json``)
stay where they are; ``parse_item_key`` recognises both layouts, and a correction of
a legacy item writes into ``.../{stem}/`` (``folder_of``).

Every object carries ``connector`` / ``connector-version`` metadata (``Connector``):
the plugin id and manifest version for a plugin, the writer id (``manual_import``,
``csv_upload``, ...) and the app release (``APP_VERSION``) for an API writer.

Used by both runtimes: the plugin bundles ship ``lambda/shared`` next to
``plugins/_shared`` (``plugins/_shared/raw_archive.py``), the API Lambdas ship it as
``shared`` (``shared/ingest_archive.py``, ``api/manual_import_handler.py``).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any, Final

from botocore.exceptions import ClientError

__all__ = [
    'CONNECTOR_META',
    'CONNECTOR_VERSION_META',
    'RAW_PREFIX',
    'UNKNOWN_VERSION',
    'Connector',
    'ItemArchive',
    'app_connector',
    'content_digest',
    'folder_of',
    'item_folder',
    'parse_item_key',
    'put_raw_version',
    'version_key',
]

RAW_PREFIX: Final = 'raw/'
CONNECTOR_META: Final = 'connector'
CONNECTOR_VERSION_META: Final = 'connector-version'
UNKNOWN_VERSION: Final = 'unknown'
DIGEST_CHARS: Final = 16
_JSON_SUFFIX: Final = '.json'
# A version file: the digest plus an extension (``.json`` for every item archive; an original
# kept as received keeps its own: ``.eml`` for an email, ``.csv`` / ``.jsonl`` for an S3 import file).
_EXTENSION: Final = r'\.[a-z0-9]{1,10}'
_VERSION_FILE_RE: Final = re.compile(rf'^[0-9a-f]{{{DIGEST_CHARS}}}{_EXTENSION}\Z')
_EXTENSION_RE: Final = re.compile(rf'^{_EXTENSION}\Z')
# Path segments of a legacy key (the stem file is the sixth) and of a versioned key (stem folder + digest file).
_LEGACY_PARTS: Final = 6
_VERSIONED_PARTS: Final = 7
_STEM_INDEX: Final = 5
_ALREADY_ARCHIVED: Final = ('PreconditionFailed', 412)
_CONCURRENT_WRITE: Final = ('ConditionalRequestConflict', 409)
_PUT_ATTEMPTS: Final = 2


@dataclass(frozen=True)
class Connector:
    """Who wrote a raw object: a plugin id and manifest version, or an API writer id and app release."""

    id: str
    version: str

    def metadata(self) -> dict[str, str]:
        """The S3 user metadata every new raw object carries."""
        return {CONNECTOR_META: self.id, CONNECTOR_VERSION_META: self.version}

    def envelope(self) -> dict[str, str]:
        """The ``connector`` field of a plugin envelope's JSON body."""
        return {'id': self.id, 'version': self.version}


def app_connector(writer_id: str) -> Connector:
    """An API-side writer (``manual_import``, ``csv_upload``, ...) at this deployment's app release."""
    return Connector(writer_id, os.environ.get('APP_VERSION') or UNKNOWN_VERSION)


def content_digest(content: object, default: Callable[[Any], Any] = str) -> str:
    """The ``{sha16}`` of ``content``: SHA-256 over its canonical JSON (sorted keys), first 16 hex chars."""
    canonical = json.dumps(content, sort_keys=True, default=default)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:DIGEST_CHARS]


def item_folder(source: str, day: date, stem: str) -> str:
    """``raw/{source}/{YYYY}/{MM}/{DD}/{stem}/``: the folder holding every version of one item."""
    return f'{RAW_PREFIX}{source}/{day.year}/{day.month:02d}/{day.day:02d}/{stem}/'


def version_key(folder: str, digest: str, extension: str = _JSON_SUFFIX) -> str:
    """The key of one version (``digest`` = ``content_digest``) inside an item folder.

    ``extension`` is ``.json`` unless the object is an original kept as received (``.eml``,
    ``.csv``, ...): lower-case alphanumerics after the dot, anything else is a ``ValueError``.
    """
    if not _EXTENSION_RE.match(extension):
        raise ValueError(f'Not a raw version extension: {extension!r}')
    return f'{folder}{digest}{extension}'


@dataclass(frozen=True)
class ItemArchive:
    """Where one item's raw objects live, in both layouts."""

    stem: str
    legacy_key: str  # raw/{source}/{y}/{m}/{d}/{stem}.json (written before the versioned layout)
    folder: str  # raw/{source}/{y}/{m}/{d}/{stem}/ (every versioned object)


def parse_item_key(key: str) -> ItemArchive | None:
    """The item archive ``key`` belongs to (legacy or versioned layout); None for any other key."""
    parts = key.split('/')
    if not key.startswith(RAW_PREFIX) or any(part in ('', '.', '..') for part in parts):
        return None
    if len(parts) == _LEGACY_PARTS and parts[-1].endswith(_JSON_SUFFIX):
        stem = parts[-1].removesuffix(_JSON_SUFFIX)
    elif len(parts) == _VERSIONED_PARTS and _VERSION_FILE_RE.match(parts[-1]):
        stem = parts[_STEM_INDEX]
    else:
        return None
    if not stem:
        return None
    base = '/'.join(parts[:_STEM_INDEX])
    return ItemArchive(stem=stem, legacy_key=f'{base}/{stem}{_JSON_SUFFIX}', folder=f'{base}/{stem}/')


def folder_of(key: str) -> str | None:
    """The item folder a correction of the item archived at ``key`` is written into (either layout)."""
    archive = parse_item_key(key)
    return archive.folder if archive else None


def _error(e: ClientError) -> tuple[str, int]:
    code = str(e.response.get('Error', {}).get('Code', ''))
    status = e.response.get('ResponseMetadata', {}).get('HTTPStatusCode', 0)
    return code, status if isinstance(status, int) else 0


def _is(error: tuple[str, int], expected: tuple[str, int]) -> bool:
    return error[0] == expected[0] or error[1] == expected[1]


def put_raw_version(
    s3: Any, bucket: str, key: str, body: str | bytes, connector: Connector, *,
    content_type: str = 'application/json', metadata: Mapping[str, str] | None = None,
) -> bool:
    """Write ``body`` at ``key`` only if no object is there yet; True when written, False when already archived.

    412 ``PreconditionFailed`` = this key (this exact content) is already archived: a
    success, nothing is overwritten. 409 ``ConditionalRequestConflict`` (another write of
    the same key in flight) is retried once; its 412 then is the same success. Any other
    error (and a second 409) raises the ``ClientError``.
    """
    request: dict[str, Any] = {
        'Bucket': bucket, 'Key': key, 'Body': body, 'ContentType': content_type, 'IfNoneMatch': '*',
        'Metadata': {**(metadata or {}), **connector.metadata()},
    }
    attempts_left = _PUT_ATTEMPTS
    while True:
        attempts_left -= 1
        try:
            s3.put_object(**request)
        except ClientError as e:
            error = _error(e)
            if _is(error, _ALREADY_ARCHIVED):
                return False
            if _is(error, _CONCURRENT_WRITE) and attempts_left > 0:
                continue
            raise
        return True
