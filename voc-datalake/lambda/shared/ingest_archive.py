"""Source policy + raw archive for the API-side producers (manual import, forms, data explorer).

The plugin transports have their own choke point (``plugins/_shared/source_policy_gate.py``);
the API Lambdas that queue feedback use these helpers so the order is the same
everywhere: resolve the source's profile, apply its PII policy to every
message, then archive only what ``archive_mode`` allows:

- ``none``  (redact / summary-only): nothing is written; ``s3_raw_uri`` is None.
- ``item``  (a retention period is set): one JSON per message at
  ``raw/{source}/{y}/{m}/{d}/{id}.json``, which the retention worker deletes
  with the item through its ``s3_raw_uri``.
- ``file``  (allow, keep forever): the caller may keep its whole-request
  archive (``raw/csv_upload/...``) as before.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import decimal_default
from shared.archive_keys import archive_key_stem
from shared.concurrency import ordered_map
from shared.exceptions import ValidationError
from shared.logging import logger
from shared.source_policy import ARCHIVE_FILE, ARCHIVE_ITEM, apply_source_policy, archive_mode
from shared.source_profiles import SOURCE_ID_RE, SourceProfilesUnavailable, load_source_profiles, profile_for

__all__ = [
    'DEFAULT_UPLOAD_SOURCE',
    'prepare_messages',
    'stamp_file_archive',
    'upload_profile',
]

DEFAULT_UPLOAD_SOURCE: Final = 'manual_import'
_ARCHIVE_WORKERS: Final = 16
_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def upload_profile(table: Any, raw_source_id: object) -> dict[str, Any]:
    """The profile an upload is filed under: a configured profile id, or ``manual_import``.

    ``ValidationError`` for anything else (an unknown id would create a source
    nobody configured). ``SourceProfilesUnavailable`` (503, retryable) when the
    profiles cannot be read: an upload must not slip past a policy it could not load.
    """
    source_id = DEFAULT_UPLOAD_SOURCE if raw_source_id in (None, '') else raw_source_id
    if not isinstance(source_id, str) or not SOURCE_ID_RE.match(source_id.strip()):
        raise ValidationError('source_id must be a configured source id')
    source_id = source_id.strip()
    try:
        profiles = load_source_profiles(table) if table is not None else []
    except (*_AWS_ERRORS, ValueError) as e:
        logger.exception('Source profiles could not be read for an upload')
        raise SourceProfilesUnavailable from e
    if source_id != DEFAULT_UPLOAD_SOURCE and source_id not in {profile['id'] for profile in profiles}:
        raise ValidationError(f'Unknown source_id "{source_id}": configure it in Administration → Privacy & access → Source policies first')
    return profile_for(profiles, source_id)


def policy_applied(messages: list[dict[str, Any]], profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every message under ``profile``'s PII policy; a redact message without text is dropped."""
    out: list[dict[str, Any]] = []
    for message in messages:
        applied = apply_source_policy(message, profile)
        if applied is not None:
            out.append(applied)
    return out


def _key_id(message_id: object) -> str:
    """The archive file stem (``shared.archive_keys``); ``item`` for a message without an id."""
    return archive_key_stem(message_id) if message_id not in (None, '') else 'item'


def _rewritten_key(bucket: str, source_id: str, uri: object) -> str | None:
    """The key of ``uri`` when it is a per-item archive of ``source_id`` in ``bucket``; else None."""
    prefix = f's3://{bucket}/'
    if not isinstance(uri, str) or not uri.startswith(prefix) or not uri.endswith('.json'):
        return None
    key = uri.removeprefix(prefix)
    return key if key.startswith(f'raw/{source_id}/') else None


def _archive_one(s3: Any, bucket: str, source_id: str, now: datetime, message: dict[str, Any],
                 rewrite_uris: Mapping[str, str]) -> str | None:
    key = _rewritten_key(bucket, source_id, rewrite_uris.get(str(message.get('id')))) or (
        f"raw/{source_id}/{now.year}/{now.month:02d}/{now.day:02d}/{_key_id(message.get('id'))}.json")
    body = {k: v for k, v in message.items() if k != 's3_raw_uri'}
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(body, default=decimal_default),
                      ContentType='application/json')
    except _AWS_ERRORS as e:
        logger.warning(f'Failed to archive one item to S3: {e}')
        return None
    return f's3://{bucket}/{key}'


def archive_per_item(s3: Any, bucket: str, source_id: str, messages: list[dict[str, Any]], now: datetime,
                     rewrite_uris: Mapping[str, str] | None = None) -> None:
    """Write one JSON per message and point its ``s3_raw_uri`` at it (None where a write failed).

    ``rewrite_uris`` (message id -> the stored item's archive) writes an update of a stored
    item over its own archive (a new version of the same key), so the item keeps ONE archive
    that retention deletes with it, instead of leaving the old one behind.
    """
    if not bucket:
        return
    rewrites = rewrite_uris or {}
    uris = ordered_map(lambda message: _archive_one(s3, bucket, source_id, now, message, rewrites), messages,
                       max_workers=_ARCHIVE_WORKERS)
    for message, uri in zip(messages, uris, strict=True):  # pragma: no mutate  ordered_map returns one result per input
        message['s3_raw_uri'] = uri


def stamp_file_archive(
    messages: list[dict[str, Any]], mode: str, write: Callable[[], str | None],
) -> str | None:
    """Under mode ``file``, run ``write`` (the caller's whole-request archive) and point every
    message's ``s3_raw_uri`` at its URI; otherwise write nothing. Returns the URI (or None)."""
    if mode != ARCHIVE_FILE:
        return None
    uri = write()
    for message in messages:
        message['s3_raw_uri'] = uri
    return uri


def prepare_messages(
    s3: Any, bucket: str, messages: list[dict[str, Any]], profile: Mapping[str, Any], now: datetime,
    rewrite_uris: Mapping[str, str] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Apply the policy, archive per item when the profile asks for it; ``(messages, archive mode)``.

    With mode ``file`` nothing is archived here: the caller keeps (or writes)
    its whole-request archive and stamps its URI itself. With ``none`` every
    ``s3_raw_uri`` is cleared.
    """
    mode = archive_mode(profile)
    out = policy_applied(messages, profile)
    if mode == ARCHIVE_ITEM:
        archive_per_item(s3, bucket, str(profile.get('id') or DEFAULT_UPLOAD_SOURCE), out, now, rewrite_uris)
    elif mode != ARCHIVE_FILE:
        for message in out:
            message['s3_raw_uri'] = None
    return out, mode
