"""Source policy + raw archive for the API-side producers (manual import, forms, data explorer).

The plugin transports have their own choke point (``plugins/_shared/source_policy_gate.py``);
the API Lambdas that queue feedback use these helpers so the order is the same
everywhere: resolve the source's profile, apply its PII policy to every
message, then archive only what ``archive_mode`` allows:

- ``none``  (redact / summary-only): nothing is written; ``s3_raw_uri`` is None.
- ``item``  (a retention period is set): one JSON per message at
  ``raw/{source}/{y}/{m}/{d}/{id}/{sha16}.json`` (``shared/raw_versions.py``:
  write-once, one folder per item holding every version), which the retention
  worker deletes with the item through its ``s3_raw_uri``.
- ``file``  (allow, keep forever): the caller may keep its whole-request
  archive (``raw/csv_upload/...``) as before.

An upload in a workspace (``scope``, the request's resolved membership: the manual import and the form import of
the import wizard, 7.67.00) reads that workspace's own profiles (a source it saved none for redacts, shared/
source_profiles.py ``profile_for``) and archives under its own bronze layer, ``ws/{ws}/raw/…``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import decimal_default
from shared.concurrency import ordered_map
from shared.exceptions import ValidationError
from shared.logging import logger, metrics
from shared.pii_redaction import EntityModelFailed, prepare_comprehend
from shared.raw_versions import (
    Connector,
    app_connector,
    content_digest,
    folder_of,
    item_folder,
    item_stem,
    put_raw_version,
    raw_root,
    version_key,
)
from shared.source_policy import ARCHIVE_FILE, ARCHIVE_ITEM, FreeText, archive_mode, quiet_policy, raw_archive_allowed
from shared.source_profiles import PII_ALLOW, SOURCE_ID_RE, SourceProfilesUnavailable, load_source_profiles, profile_for
from shared.ws_repo import WorkspaceScope

__all__ = [
    'DEFAULT_UPLOAD_SOURCE',
    'prepare_messages',
    'stamp_file_archive',
    'upload_profile',
]

DEFAULT_UPLOAD_SOURCE: Final = 'manual_import'
_ARCHIVE_WORKERS: Final = 16
#: Messages redacted at once: a redact policy with ``PII_COMPREHEND=1`` makes one Comprehend call per free text, so
#: one after another a large upload outlasted API Gateway's 29 s (7.67.00's form import).
_POLICY_WORKERS: Final = 8
_AWS_ERRORS: Final = (ClientError, BotoCoreError)


def upload_profile(table: Any, raw_source_id: object, scope: WorkspaceScope | None = None) -> dict[str, Any]:
    """The profile an upload is filed under: a configured profile id, or ``manual_import``; in ``scope``'s workspace,
    one of that workspace's own.

    ``ValidationError`` for anything else (an unknown id would create a source
    nobody configured). ``SourceProfilesUnavailable`` (503, retryable) when the
    profiles cannot be read: an upload must not slip past a policy it could not load.
    """
    source_id = DEFAULT_UPLOAD_SOURCE if raw_source_id in (None, '') else raw_source_id
    if not isinstance(source_id, str) or not SOURCE_ID_RE.match(source_id.strip()):
        raise ValidationError('source_id must be a configured source id')
    source_id = source_id.strip()
    try:
        profiles = load_source_profiles(table, scope) if table is not None else []
    except (*_AWS_ERRORS, ValueError) as e:
        logger.exception('Source profiles could not be read for an upload')
        raise SourceProfilesUnavailable from e
    if source_id != DEFAULT_UPLOAD_SOURCE and source_id not in {profile['id'] for profile in profiles}:
        raise ValidationError(f'Unknown source_id "{source_id}": configure it in Administration → Privacy & access → Source policies first')
    return profile_for(profiles, source_id, workspace=scope is not None)


def policy_applied(messages: list[dict[str, Any]], profile: Mapping[str, Any], *, free_text: FreeText = None,
                   unreadable: list[str] | None = None) -> list[dict[str, Any]]:
    """Every message under ``profile``'s PII policy, several at once and in order; a redact message without text is
    dropped. ``free_text``: the metadata paths the entity model reads (shared/source_policy.py ``FreeText``).

    ``unreadable`` given: the redaction is strict, so a message one of whose texts the entity model should have read
    and could not (Comprehend failed after its retries) is left out and its id appended there, never kept with a
    pattern-only redaction. The Comprehend client is built before the workers start, so they share it."""
    strict = unreadable is not None
    if not raw_archive_allowed(profile):
        prepare_comprehend()

    def one(message: dict[str, Any]) -> dict[str, Any] | EntityModelFailed | None:
        try:
            return quiet_policy(message, profile, free_text=free_text, strict=strict)
        except EntityModelFailed as failed:
            return failed

    applied = ordered_map(one, messages, max_workers=_POLICY_WORKERS)
    out: list[dict[str, Any]] = []
    for message, result in zip(messages, applied, strict=True):  # pragma: no mutate  one result per input
        if isinstance(result, EntityModelFailed):
            if unreadable is not None:
                unreadable.append(str(message.get('id')))
        elif result is not None:
            out.append(result)
    redacted = sum(1 for message in out if message['pii_policy_applied'] != PII_ALLOW)
    if redacted:
        metrics.add_metric(name='PiiPolicyApplied', unit='Count', value=redacted)
    return out


def _stored_folder(bucket: str, source_id: str, uri: object, scope: WorkspaceScope | None = None) -> str | None:
    """The item folder of ``uri`` when it is a per-item archive of ``source_id`` in ``bucket`` (under ``scope``'s
    bronze root); else None.

    Either layout: a legacy ``.../{stem}.json`` maps to ``.../{stem}/``, a versioned
    ``.../{stem}/{sha16}.json`` to its own folder (``shared.raw_versions.folder_of``).
    """
    if not isinstance(uri, str):
        return None
    key = uri.removeprefix(f's3://{bucket}/')
    in_source = key != uri and key.startswith(f'{raw_root(scope)}{source_id}/')
    return folder_of(key) if in_source else None


def _archive_one(s3: Any, bucket: str, source_id: str, now: datetime, message: dict[str, Any],
                 rewrite_uris: Mapping[str, str], connector: Connector,
                 scope: WorkspaceScope | None = None) -> str | None:
    body = {k: v for k, v in message.items() if k != 's3_raw_uri'}
    digest = content_digest(body, default=decimal_default)
    folder = _stored_folder(bucket, source_id, rewrite_uris.get(str(message.get('id'))), scope) or item_folder(
        source_id, now, item_stem(message.get('id'), digest), scope)
    key = version_key(folder, digest)
    try:
        put_raw_version(s3, bucket, key, json.dumps(body, default=decimal_default), connector)
    except _AWS_ERRORS as e:
        logger.warning(f'Failed to archive one item to S3: {e}')
        return None
    return f's3://{bucket}/{key}'


def archive_per_item(
    s3: Any, bucket: str, source_id: str, messages: list[dict[str, Any]], now: datetime,
    rewrite_uris: Mapping[str, str] | None = None, *, connector_id: str = DEFAULT_UPLOAD_SOURCE,
    scope: WorkspaceScope | None = None,
) -> None:
    """Write one JSON per message and point its ``s3_raw_uri`` at it (None where a write failed).

    Write-once (``shared/raw_versions.py``): a message whose content is already archived
    gets that object's URI, a changed one a new object in the item's folder. ``rewrite_uris``
    (message id -> the stored item's archive) files a CORRECTION of a stored item into that
    item's own folder (a legacy ``.../{stem}.json`` archive's folder is ``.../{stem}/``),
    so retention deletes the old and the new version with the item; the item then
    references the newest version. ``connector_id`` names the writer in the object's
    metadata (``manual_import``, ``csv_upload``, ``json_upload``, ...).
    """
    if not bucket:
        return
    rewrites = rewrite_uris or {}
    connector = app_connector(connector_id)
    uris = ordered_map(lambda message: _archive_one(s3, bucket, source_id, now, message, rewrites, connector, scope),
                       messages, max_workers=_ARCHIVE_WORKERS)
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
    rewrite_uris: Mapping[str, str] | None = None, *, connector_id: str = DEFAULT_UPLOAD_SOURCE,
    scope: WorkspaceScope | None = None, free_text: FreeText = None, unreadable: list[str] | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """Apply the policy, archive per item when the profile asks for it; ``(messages, archive mode)``.

    With mode ``file`` nothing is archived here: the caller keeps (or writes)
    its whole-request archive and stamps its URI itself. With ``none`` every
    ``s3_raw_uri`` is cleared. ``connector_id`` is the writer recorded on each archive. ``scope``: the workspace an
    upload acts in (its archives under ``ws/{ws}/raw/``). ``free_text``: the metadata paths of the messages' free text,
    the only metadata the entity model reads (None: all of it). ``unreadable``: a strict redaction, the ids of the
    messages left out because the entity model could not read them (``policy_applied``).
    """
    mode = archive_mode(profile)
    out = policy_applied(messages, profile, free_text=free_text, unreadable=unreadable)
    if mode == ARCHIVE_ITEM:
        archive_per_item(s3, bucket, str(profile.get('id') or DEFAULT_UPLOAD_SOURCE), out, now, rewrite_uris,
                         connector_id=connector_id, scope=scope)
    elif mode != ARCHIVE_FILE:
        for message in out:
            message['s3_raw_uri'] = None
    return out, mode
