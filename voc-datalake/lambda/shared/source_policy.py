"""Apply a source profile's data-protection policy at ingestion.

Every producer (plugin ingestors and webhooks, manual import, the feedback-form
submit, the data explorer) calls ``apply_source_policy`` on each message BEFORE
it archives anything and before it queues the message, and archives only what
``archive_mode`` allows:

- ``allow``: the message travels unchanged; raw archives as today.
- ``redact``: ``text``, ``title``, ``url`` and ``source_url`` go through
  ``shared.pii_redaction`` (a query string can carry an email), ``author`` (and
  the author's avatar URL) are dropped, every string metadata value is redacted
  — at any depth, inside nested maps such as ``custom_fields`` and inside lists
  — and no raw copy is archived (the redacted message is the only copy that exists). A caller that names its
  messages' free text (``quiet_policy``'s ``free_text``: a form import's open answers and hidden values) sends only
  that, the text and the title to the entity model; their ids, codes and URLs get the patterns alone. With
  ``strict`` (every redacting upload, shared/ingest_archive.py) a text the entity model should have read and could not
  raises ``EntityModelFailed`` instead of keeping its pattern-only redaction; one live record (``apply_source_policy``:
  a form's submission, an edit, a voice transcript) keeps the pattern result.
- ``summary_only``: the same redaction; the processor then stores derived
  fields only (``shared.source_profiles`` contract).

``archive_mode`` also says HOW an allowed source is archived: a source with a
retention period archives per item (``raw/{source}/{y}/{m}/{d}/{id}.json``) so
the retention worker can delete each item's copy; a keep-forever source may keep
a whole uploaded file (``raw/csv_upload/...``), which only a whole-source erasure
of that source deletes (``shared/retention.py``).
"""

from __future__ import annotations

from collections.abc import Collection, Mapping
from typing import Any, Final

from shared.ingest_schemas import MAX_METADATA_VALUE_LENGTH, MAX_TEXT_LENGTH, MAX_URL_LENGTH
from shared.logging import logger, metrics
from shared.pii_redaction import redact_text
from shared.source_profiles import PII_ALLOW, PII_POLICIES, cached_source_profile_strict
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope

__all__ = [
    'ARCHIVE_FILE',
    'ARCHIVE_ITEM',
    'FreeText',
    'apply_source_policy',
    'archive_mode',
    'policy_message',
    'quiet_policy',
    'raw_archive_allowed',
]

ARCHIVE_NONE: Final = 'none'
ARCHIVE_ITEM: Final = 'item'
ARCHIVE_FILE: Final = 'file'

# Message fields that identify the author and are dropped outright under a
# non-allow policy (redacting a name with patterns alone would keep it).
_AUTHOR_FIELDS: Final = ('author',)
_AUTHOR_METADATA_FIELDS: Final = frozenset({
    'author_image', 'author_name', 'author_url', 'username', 'submitter_name'})
# Raw producer payload carried only when the S3 archive failed: never sent redacted.
_RAW_FIELDS: Final = ('raw_data', 's3_raw_uri')
# A placeholder can be longer than what it replaces ("a@b.io" -> "[EMAIL]"), so
# redacted values are re-bounded to the queue schema's limits.
_MAX_TITLE_LENGTH: Final = 500
# Top-level message fields holding a URL, whose query string may carry PII.
_URL_FIELDS: Final = ('url', 'source_url')
# The metadata keys an erasure by email matches (``shared.retention``): stored lower-cased.
EMAIL_METADATA_FIELDS: Final = ('email', 'submitter_email')
#: The metadata paths (keys from ``metadata`` down, a list's items under their list's path) of a message's free text:
#: only those, beside ``text`` and ``title``, reach the entity model (``shared.pii_redaction``'s Comprehend pass);
#: every other string (an id, a code, a URL) gets the pattern pass only. None: every string reaches it.
FreeText = Collection[tuple[str, ...]] | None


def _bounded(text: str, limit: int) -> str:
    return text[:limit]


def _pii(profile: Mapping[str, Any]) -> str:
    pii = profile.get('pii')
    return pii if isinstance(pii, str) and pii in PII_POLICIES else PII_ALLOW


def raw_archive_allowed(profile: Mapping[str, Any]) -> bool:
    """True when the source may keep a raw copy of what it ingests (pii ``allow``)."""
    return _pii(profile) == PII_ALLOW


def archive_mode(profile: Mapping[str, Any]) -> str:
    """How a source's raw data may be archived: ``none``, ``item`` or ``file``.

    ``none`` for a redact/summary-only source; ``item`` (one JSON per item, which
    the retention worker can delete) when a retention period is set; ``file``
    (a whole uploaded file may be kept) for an allow, keep-forever source.
    """
    if not raw_archive_allowed(profile):
        return ARCHIVE_NONE
    return ARCHIVE_ITEM if profile.get('retention_days') is not None else ARCHIVE_FILE


def _redacted(value: object, language: str | None, free_text: FreeText = None, path: tuple[str, ...] = (), *,
              strict: bool = False) -> object:
    """``value`` with every string redacted: recursing into maps and lists, author keys dropped; a string off
    ``free_text``'s paths by the patterns alone."""
    if isinstance(value, str):
        model_language = language if free_text is None or path in free_text else None
        return _bounded(redact_text(value, model_language, strict=strict).text, MAX_METADATA_VALUE_LENGTH)
    if isinstance(value, Mapping):
        return {key: _redacted(item, language, free_text, (*path, str(key)), strict=strict)
                for key, item in value.items() if key not in _AUTHOR_METADATA_FIELDS}
    if isinstance(value, list | tuple):
        return [_redacted(item, language, free_text, path, strict=strict) for item in value]
    return value


def _lower_cased_emails(message: Mapping[str, Any]) -> dict[str, Any]:
    """``message`` with ``metadata.email`` / ``metadata.submitter_email`` lower-cased (erasure matches them)."""
    out = dict(message)
    metadata = message.get('metadata')
    if isinstance(metadata, Mapping) and any(isinstance(metadata.get(k), str) for k in EMAIL_METADATA_FIELDS):
        out['metadata'] = {key: value.strip().lower() if key in EMAIL_METADATA_FIELDS and isinstance(value, str)
                           else value for key, value in metadata.items()}
    return out


def _redact_message(message: Mapping[str, Any], free_text: FreeText = None, *, strict: bool = False) -> dict[str, Any]:
    language = message.get('language') if isinstance(message.get('language'), str) else None
    out = {key: value for key, value in message.items()
           if key not in _AUTHOR_FIELDS and key not in _RAW_FIELDS}
    # The caller passes only a non-blank string ``text``, and a placeholder is never empty.
    out['text'] = _bounded(redact_text(message['text'], language, strict=strict).text, MAX_TEXT_LENGTH)
    if isinstance(message.get('title'), str):
        out['title'] = _bounded(redact_text(message['title'], language, strict=strict).text, _MAX_TITLE_LENGTH)
    for field in _URL_FIELDS:
        if isinstance(message.get(field), str):
            out[field] = _bounded(redact_text(message[field], language if free_text is None else None,
                                              strict=strict).text, MAX_URL_LENGTH)
    if 'metadata' in message:
        out['metadata'] = _redacted(message['metadata'], language, free_text, strict=strict)
    return out


def quiet_policy(message: Mapping[str, Any], profile: Mapping[str, Any], *,
                 free_text: FreeText = None, strict: bool = False) -> dict[str, Any] | None:
    """``apply_source_policy`` without its metric, for a caller that applies the policy to many messages on worker
    threads (shared/ingest_archive.py ``policy_applied``) and counts them itself, once, on its own thread.
    ``free_text`` (``FreeText``): the metadata paths that hold a person's own words, the only metadata the entity
    model reads (None: all of it). ``strict``: a text the entity model should have read and could not raises
    shared/pii_redaction.py ``EntityModelFailed`` (see the module docstring)."""
    pii = _pii(profile)
    message = {key: value for key, value in _lower_cased_emails(message).items() if key != WORKSPACE_FIELD}
    if pii == PII_ALLOW:
        return {**message, 'pii_policy_applied': PII_ALLOW}
    if not isinstance(message.get('text'), str) or not message['text'].strip():
        return None
    out = _redact_message(message, free_text, strict=strict)
    out['pii_policy_applied'] = pii
    return out


def apply_source_policy(message: Mapping[str, Any], profile: Mapping[str, Any]) -> dict[str, Any] | None:
    """The message to archive/queue under ``profile``, with ``pii_policy_applied`` set.

    An ``allow`` message always passes (the queue schema judges it as before).
    Under a non-allow policy a message without text is None: there is nothing
    to redact and nothing worth queueing. The input is never mutated.

    Never returns ``workspace_id`` (docs/multi-workspace.md): the field names the workspace the processor stores
    the message in, so only a plugin ingestor's run in a workspace sets it, from its verified scope, AFTER this
    policy (``BaseIngestor.send_to_queue``). A producer's content (a request body, a source payload) can never
    choose it.
    """
    out = quiet_policy(message, profile)
    if out is not None and out['pii_policy_applied'] != PII_ALLOW:
        metrics.add_metric(name='PiiPolicyApplied', unit='Count', value=1)
    return out


def policy_message(message: Mapping[str, Any],
                   scope: WorkspaceScope | None = None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """``apply_source_policy`` under the cached profile of the message's ``source_platform``: ``scope``'s
    workspace's for a producer in a workspace (a plugin run in one, a workspace's webhook), the deployment's
    without one.

    Returns ``(message or None, profile)`` so the caller can also ask
    ``archive_mode(profile)``. FAILS CLOSED: raises ``SourceProfilesUnavailable``
    when the profiles cannot be read, so the message is retried rather than
    queued under the allow default.
    """
    source_id = str(message.get('source_platform') or '')
    profile = cached_source_profile_strict(source_id, scope)
    out = apply_source_policy(message, profile)
    if out is None:
        logger.warning('Message without text skipped by the source policy', extra={'source_platform': source_id})
    return out, profile
