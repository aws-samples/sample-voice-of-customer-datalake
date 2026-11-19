"""Workspace delete records: one audit row per deleted artifact (TENETS.md D4, D5).

When an owner deletes a workspace artifact (a project, persona, document, revision,
product doc, board, request, list, conversation, company-context file …) the delete is
real, and it is RECORDED in the table that held the artifact:

- ``pk 'AUDIT#delete'`` / ``sk '{iso}#{uuid4 hex}'`` (newest last, never collides); a delete that may be run
  again until it finishes (a feedback form's, since 7.04.00) uses ``record_delete_once``'s deterministic
  ``sk '{kind}#{id}'`` instead, so it has exactly one row;
- ``kind`` (what was deleted, e.g. ``persona``), ``target`` (ids only, never content),
  ``actor`` (``{sub, kind}``; kind is ``user | admin | agent | mcp | plan | system``,
  never an email), ``reason`` (optional), ``count`` (optional: how many rows one delete removes, e.g. a form's
  test responses), ``deleted_at``.

The row carries no ``ttl``: an audit trail never expires. It is written with
``attribute_not_exists(pk)`` so an existing row is never overwritten.

Recording a delete never fails the delete: ``record_delete`` logs a warning (the kind
only), counts the ``DeleteRecordFailures`` metric (namespace ``VoC``) so a missing record is visible, and
returns. ``record_delete_once`` and ``record_delete_first`` are the strict pair: their record is written BEFORE the
delete and raises when it cannot be, so nothing is deleted without its row.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.ai_writing import PLAN_PRINCIPAL_CLAIM, PLAN_PRINCIPAL_PREFIX
from shared.api import get_caller_groups
from shared.aws import is_conditional_check_failure
from shared.logging import logger, metrics
from shared.project_access import (
    ADMIN_GROUP,
    AGENT_SUBJECT_PREFIX,
    DELEGATED_SUBJECT_PREFIX,
    claim_text,
    claims_from_event,
)
from shared.silver_provenance import SYSTEM_ACTOR
from shared.timestamps import now_iso

__all__ = ['actor_from_event', 'record_delete', 'record_delete_first', 'record_delete_once']

AUDIT_PK: Final = 'AUDIT#delete'
#: Each target id / actor field / reason is cut to this many characters.
_MAX_TEXT: Final = 300


def actor_from_event(event: Mapping[str, Any], *, admin: bool | None = None) -> dict[str, str]:
    """``{sub, kind}`` of an API Gateway event's caller (never an email).

    ``agent`` / ``mcp`` for those synthetic subjects, ``plan`` for a plan step acting
    for its approver (the sub is the approver's), ``admin`` / ``user`` for a person,
    ``system`` when the event carries no subject. ``admin`` overrides the groups claim
    when the route decided it itself (a board-pool token's groups are never honoured).
    """
    claims = claims_from_event(event)
    sub = claim_text(claims, 'sub')
    if not sub:
        return dict(SYSTEM_ACTOR)
    if sub.startswith(AGENT_SUBJECT_PREFIX):
        return {'sub': sub, 'kind': 'agent'}
    if sub.startswith(DELEGATED_SUBJECT_PREFIX):
        return {'sub': sub, 'kind': 'mcp'}
    if claim_text(claims, PLAN_PRINCIPAL_CLAIM).startswith(PLAN_PRINCIPAL_PREFIX):
        return {'sub': sub, 'kind': 'plan'}
    is_admin = ADMIN_GROUP in get_caller_groups(dict(event)) if admin is None else admin
    return {'sub': sub, 'kind': 'admin' if is_admin else 'user'}


def _texts(values: Mapping[str, object]) -> dict[str, str]:
    """The non-empty string values, each cut to a bounded length."""
    return {str(k): v[:_MAX_TEXT] for k, v in values.items() if isinstance(v, str) and v}


def record_delete_once(
    table: Any,
    *,
    kind: str,
    record_id: str,
    target: Mapping[str, str],
    actor: Mapping[str, str] | None,
    reason: str | None = None,
    counts: Mapping[str, int] | None = None,
) -> bool:
    """The ``AUDIT#delete`` row of a delete that may be run again until it finishes (a feedback form's):
    ``sk`` ``{kind}#{record_id}``, deterministic, put only if absent, so every attempt writes it and one delete has
    exactly one row, never two and never none. True when this call wrote it, False when an earlier attempt had.
    ``counts``: what else the delete is about to remove, by name (a form's ``test_responses_deleted``), as the
    first attempt counted it. Unlike ``record_delete`` it RAISES on any other failure: the delete is not done until
    its record is."""
    try:
        _put_record(table, lambda _now: f'{kind}#{record_id}', kind=kind, target=target, actor=actor, reason=reason,
                    counts=counts)
    except ClientError as error:
        if is_conditional_check_failure(error):
            return False
        raise
    return True


def record_delete_first(
    table: Any,
    *,
    kind: str,
    target: Mapping[str, str],
    actor: Mapping[str, str] | None,
    count: int,
    reason: str | None = None,
) -> None:
    """The ``AUDIT#delete`` row of a delete that is recorded BEFORE it runs and may happen again later (a form's test
    responses, since 7.04.00: each delete is its own event): a new row each time (``sk`` ``{iso}#{uuid4 hex}``, as
    ``record_delete``), with ``count``, the rows the delete is about to remove. Unlike ``record_delete`` it RAISES on
    any failure: the caller deletes nothing without its record."""
    _put_record(table, lambda now: f'{now}#{uuid.uuid4().hex}', kind=kind, target=target, actor=actor, reason=reason,
                count=count)


#: The fields every ``AUDIT#delete`` row has or may have; a ``counts`` name is never one of them.
_ROW_FIELDS: Final = frozenset({'pk', 'sk', 'kind', 'target', 'actor', 'deleted_at', 'reason', 'count'})


def _put_record(table: Any, sort_key: Callable[[str], str], *, kind: str, target: Mapping[str, str],
                actor: Mapping[str, str] | None, reason: str | None, count: int | None = None,
                counts: Mapping[str, int] | None = None) -> None:
    """One ``AUDIT#delete`` row (``sort_key`` given the time), put only if its key is new; errors propagate.
    ``counts`` adds whole-number fields by name, never one of the row's own."""
    now = now_iso()
    item: dict[str, Any] = {
        'pk': AUDIT_PK,
        'sk': sort_key(now),
        'kind': kind,
        'target': _texts(target),
        'actor': _texts(actor) if actor else dict(SYSTEM_ACTOR),
        'deleted_at': now,
    }
    if reason:
        item['reason'] = reason[:_MAX_TEXT]
    if count is not None:
        item['count'] = count
    for name, value in (counts or {}).items():
        if name in _ROW_FIELDS:
            raise ValueError(f'{name!r} is one of the audit row\'s own fields')
        item[name] = value
    table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')


def record_delete(
    table: Any,
    *,
    kind: str,
    target: Mapping[str, str],
    actor: Mapping[str, str] | None,
    reason: str | None = None,
) -> None:
    """Write one ``AUDIT#delete`` row to ``table``; never raises (see the module docstring)."""
    try:
        _put_record(table, lambda now: f'{now}#{uuid.uuid4().hex}', kind=kind, target=target, actor=actor,
                    reason=reason)
    except Exception as exc:  # noqa: BLE001 - recording a delete never fails the delete
        logger.warning('Could not record a delete', extra={'kind': kind, 'error_type': type(exc).__name__})
        # Visible, not silent: a delete that went through without its record can be found and backfilled.
        metrics.add_metric(name='DeleteRecordFailures', unit='Count', value=1)
