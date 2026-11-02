"""One raw copy of one received thing, for the writers that are not a plugin or an upload.

The feedback-form submit route, the processor's inline fallback, the feedback boards, the email
inbox and the S3 import ingestor each keep the content they received as a write-once versioned
object (``shared/raw_versions.py``)::

    raw/{source}/{YYYY}/{MM}/{DD}/{stem}/{sha16}{extension}

A JSON copy (``json_copy``) is digested over its canonical JSON like every item archive; an
original kept as received (``bytes_copy``: an ``.eml``, an import file) over its bytes. Identical
content maps to the same key and writes nothing new.

A failed write NEVER raises (the feedback must not be lost because its copy was): it is logged and
the caller gets None. Whether a copy may be written at all (the source policy: a redact /
summary-only source keeps none) is the caller's check, made before calling; a writer that has
no profile in hand asks ``source_permits_raw_copy``.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import get_s3_client
from shared.logging import logger
from shared.raw_versions import (
    DIGEST_CHARS,
    Connector,
    app_connector,
    content_digest,
    item_folder,
    put_raw_version,
    version_key,
)
from shared.source_policy import ARCHIVE_NONE, archive_mode
from shared.source_profiles import SourceProfilesUnavailable, cached_source_profile_strict, source_profile_configured

__all__ = ['RawTarget', 'app_json_copy', 'bytes_copy', 'source_archive_mode', 'source_permits_raw_copy']

_AWS_ERRORS = (ClientError, BotoCoreError)


@dataclass(frozen=True)
class RawTarget:
    """Where one item's copies go: the bucket, the source folder, the partition day and the item stem."""

    bucket: str
    source: str
    day: date
    stem: str

    def key(self, digest: str, extension: str) -> str:
        return version_key(item_folder(self.source, self.day, self.stem), digest, extension)


def _unreadable[T](source: str, fallback: T) -> T:
    """Log that no copy is written because the source policy is unreadable; return ``fallback``."""
    logger.warning('Raw copy not written: the source policy is unreadable', extra={'source': source})
    return fallback


def source_archive_mode(source: str) -> str:
    """``source``'s archive mode (``shared.source_policy.archive_mode``: ``none`` / ``item`` / ``file``).

    Read strictly: an unreadable profile is ``none`` (logged), so nothing is archived under the
    allow default. Never raises.
    """
    try:
        return archive_mode(cached_source_profile_strict(source))
    except SourceProfilesUnavailable:
        return _unreadable(source, ARCHIVE_NONE)


def source_permits_raw_copy(source: str, *, require_profile: bool = False) -> bool:
    """True when ``source``'s profile permits a raw copy (see ``source_archive_mode``). Never raises.

    ``require_profile``: also require an admin-saved profile for ``source`` (an opt-in copy, e.g.
    the feedback boards, whose copies hold personal data that erasure by email does not reach).
    """
    if require_profile:
        try:
            if not source_profile_configured(source):
                return False
        except SourceProfilesUnavailable:
            return _unreadable(source, False)
    return source_archive_mode(source) != ARCHIVE_NONE


def bytes_digest(body: bytes) -> str:
    """The ``{sha16}`` of an original kept as received: SHA-256 of its bytes, first 16 hex chars."""
    return hashlib.sha256(body).hexdigest()[:DIGEST_CHARS]


def _write(s3: Any, target: RawTarget, key: str, body: str | bytes, connector: Connector, *,
           content_type: str, metadata: Mapping[str, str] | None) -> str | None:
    try:
        written = put_raw_version(s3, target.bucket, key, body, connector, content_type=content_type,
                                  metadata=metadata)
    except _AWS_ERRORS as e:
        logger.warning('Raw copy not written', extra={'source': target.source, 'error_type': type(e).__name__})
        return None
    logger.info('Raw copy written' if written else 'Raw copy already archived', extra={'source': target.source})
    return f's3://{target.bucket}/{key}'


def json_copy(s3: Any, target: RawTarget, content: object, connector: Connector, *,
              default: Callable[[Any], Any] = str, metadata: Mapping[str, str] | None = None) -> str | None:
    """Write ``content`` as JSON (digest over its canonical JSON); its ``s3://`` URI, or None (no bucket, failed)."""
    if not target.bucket:
        return None
    key = target.key(content_digest(content, default=default), '.json')
    body = json.dumps(content, sort_keys=True, default=default)
    return _write(s3, target, key, body, connector, content_type='application/json', metadata=metadata)


def bytes_copy(s3: Any, target: RawTarget, body: bytes, connector: Connector, *, extension: str,
               content_type: str, metadata: Mapping[str, str] | None = None) -> str | None:
    """Write ``body`` as received (digest over its bytes); its ``s3://`` URI, or None (no bucket, failed)."""
    if not target.bucket:
        return None
    key = target.key(bytes_digest(body), extension)
    return _write(s3, target, key, body, connector, content_type=content_type, metadata=metadata)


def app_json_copy(source: str, day: date, stem: str, content: object, connector_id: str) -> str | None:
    """An API-side writer's JSON copy in this Lambda's raw bucket (``RAW_DATA_BUCKET``), recorded as
    ``connector_id`` at the app release (``APP_VERSION``); its URI, or None (no bucket, failed)."""
    bucket = os.environ.get('RAW_DATA_BUCKET', '')
    if not bucket:
        return None
    return json_copy(get_s3_client(), RawTarget(bucket, source, day, stem), content, app_connector(connector_id))
