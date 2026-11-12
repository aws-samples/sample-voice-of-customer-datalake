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

A workspace's items (docs/multi-workspace.md; a plugin ingestor's run in a workspace) live
under the workspace's own root, ``ws/{ws}/raw/{source}/{YYYY}/{MM}/{DD}/{stem}/{sha16}.json``
(``item_folder`` with a scope, built by ``shared/ws_repo.py s3_key`` from a verified scope);
``parse_item_key`` reads that layout too. The bucket's write-once policy covers both roots.

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

from shared.archive_keys import archive_key_stem
from shared.workspace_ids import is_workspace_id
from shared.ws_repo import WorkspaceScope, s3_key

__all__ = [
    'RAW_PREFIX',
    'UNKNOWN_VERSION',
    'Connector',
    'app_connector',
    'content_digest',
    'folder_of',
    'item_folder',
    'item_stem',
    'parse_item_key',
    'put_raw_version',
    'raw_root',
    'version_key',
]

RAW_PREFIX: Final = 'raw/'
#: The bronze tier's folder: ``raw/`` at the bucket's root (deployment-wide), or under ``ws/{ws}/``.
RAW_TIER: Final = 'raw'
WORKSPACE_ROOT: Final = 'ws'
_WORKSPACE_SEGMENTS: Final = 2
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


def item_folder(source: str, day: date, stem: str, scope: WorkspaceScope | None = None) -> str:
    """The folder holding every version of one item: ``raw/{source}/{YYYY}/{MM}/{DD}/{stem}/`` deployment-wide, or
    ``ws/{ws}/raw/{source}/{YYYY}/{MM}/{DD}/{stem}/`` for a run in ``scope`` (``s3_key``, which refuses an empty,
    ``.`` or ``..`` segment, so a source or stem can never climb out of the workspace)."""
    if scope is None:
        return f'{RAW_PREFIX}{source}/{day.year}/{day.month:02d}/{day.day:02d}/{stem}/'
    return s3_key(scope, RAW_TIER, source, f'{day.year}', f'{day.month:02d}', f'{day.day:02d}', stem) + '/'


def raw_root(scope: WorkspaceScope | None = None) -> str:
    """Where the bronze tier starts: ``raw/`` deployment-wide, ``ws/{ws}/raw/`` in ``scope``. A reader or a delete of
    an item's own raw objects (the category reprocess's raw mode, voc-retention) only follows a key under the root of
    the item's own scope, so a deployment item never reaches a workspace's bronze, nor one workspace another's."""
    return RAW_PREFIX if scope is None else s3_key(scope, RAW_TIER) + '/'


def item_stem(item_id: object, digest: str) -> str:
    """The folder stem of one item: its id's collision-free stem, or ``noid-{digest}`` (its content)
    for an item without an id, so items without ids never share a folder (nor an erasure)."""
    return archive_key_stem(item_id) if isinstance(item_id, str) and item_id else f'noid-{digest}'


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


def _workspace_raw_offset(parts: list[str]) -> int | None:
    """How many leading segments a workspace key adds before ``raw/`` (``ws/{ws}/``: 2), 0 for a deployment-wide
    ``raw/`` key, None for any other key."""
    if parts[0] == RAW_TIER:
        return 0
    if len(parts) > _WORKSPACE_SEGMENTS and parts[0] == WORKSPACE_ROOT and is_workspace_id(parts[1]) \
            and parts[_WORKSPACE_SEGMENTS] == RAW_TIER:
        return _WORKSPACE_SEGMENTS
    return None


def parse_item_key(key: str) -> ItemArchive | None:
    """The item archive ``key`` belongs to; None for any other key.

    Two roots: the deployment-wide ``raw/...`` (legacy ``{stem}.json`` or versioned ``{stem}/{sha16}.json``) and a
    workspace's ``ws/{ws}/raw/...`` (versioned only: nothing was ever archived there in the legacy layout).
    """
    parts = key.split('/')
    if any(part in ('', '.', '..') for part in parts):
        return None
    offset = _workspace_raw_offset(parts)
    if offset is None:
        return None
    if offset == 0 and len(parts) == _LEGACY_PARTS and parts[-1].endswith(_JSON_SUFFIX):
        stem = parts[-1].removesuffix(_JSON_SUFFIX)
    elif len(parts) == _VERSIONED_PARTS + offset and _VERSION_FILE_RE.match(parts[-1]):
        stem = parts[_STEM_INDEX + offset]
    else:
        return None
    if not stem:
        return None
    base = '/'.join(parts[:_STEM_INDEX + offset])
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
    """Match on the error code; fall back to the HTTP status only when the code is empty, so an
    unrelated 412 / 409 is never read as "already archived" / "concurrent write"."""
    code, status = error
    return code == expected[0] if code else status == expected[1]


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
