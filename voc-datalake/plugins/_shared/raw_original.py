"""The raw-lake copy of a staged import file as uploaded (the ``s3_import`` plugin).

The import bucket is an inbox: its staged files expire. Before the ingestor reads one, the
original bytes go to the raw lake, write-once and versioned (``shared/raw_copy.py``)::

    raw/s3_import/{YYYY}/{MM}/{DD}/{file stem}/{sha16}.{csv|json|jsonl}

(``ws/{ws}/raw/s3_import/...`` for a run in a workspace, docs/multi-workspace.md) with connector ``s3_import`` at its manifest
version and the S3 metadata ``original-key`` (the staged key, URL-quoted). A GetObject + conditional
PutObject, never CopyObject: the raw bucket's policy refuses a put under ``raw/`` or ``ws/{ws}/raw/``
without ``If-None-Match``. The file stem is the staged key
without ``processed/`` and its extension, so a reprocess of the same file maps to the same folder
and, with identical bytes, writes nothing new.

ONLY when the ``s3_import`` profile keeps whole files (``archive_mode`` ``file``: pii ``allow`` and
no retention period). A whole file holds many items and the retention worker deletes per item, so
a source with a retention period (or a redact / summary-only one) keeps no original; its items keep
their own per-item archives as before. A whole-source erasure of ``s3_import`` sweeps the folder.
An unreadable profile or a failed write is logged; the file is imported all the same.
"""

import os
import sys
import urllib.parse
from datetime import UTC, datetime
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.archive_keys import archive_key_stem
from shared.plugin_identity import S3_IMPORT_SOURCE
from shared.raw_copy import RawTarget, bytes_copy, source_archive_mode
from shared.source_policy import ARCHIVE_FILE
from shared.ws_repo import WorkspaceScope

from .raw_archive import plugin_connector

__all__ = ["archive_original"]

PROCESSED_PREFIX = "processed/"
_CONTENT_TYPES = {".csv": "text/csv", ".json": "application/json", ".jsonl": "application/x-ndjson"}


def file_stem(key: str) -> str:
    """The folder of a staged file's versions: its key without ``processed/`` and extension."""
    base = key.removeprefix(PROCESSED_PREFIX)
    root, _ext = os.path.splitext(base)
    return archive_key_stem(root.replace("/", "__"))


def archive_original(s3: Any, bucket: str, key: str, body: bytes, *, scope: WorkspaceScope | None) -> str | None:
    """The ``s3://`` URI of the staged file's raw copy, in the *scope*'s ``ws/{ws}/raw/`` (a run in a workspace) or
    the deployment-wide ``raw/`` (scope None); None when not kept (policy, no bucket, failed)."""
    extension = os.path.splitext(key)[1].lower()
    content_type = _CONTENT_TYPES.get(extension)
    if not bucket or content_type is None or source_archive_mode(S3_IMPORT_SOURCE, scope) != ARCHIVE_FILE:
        return None
    target = RawTarget(bucket, S3_IMPORT_SOURCE, datetime.now(UTC).date(), file_stem(key), scope)
    return bytes_copy(s3, target, body, plugin_connector(), extension=extension, content_type=content_type,
                      metadata={"original-key": urllib.parse.quote(key, safe="/")})
