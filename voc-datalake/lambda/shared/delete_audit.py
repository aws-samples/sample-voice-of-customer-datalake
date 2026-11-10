"""Workspace delete records: one audit row per deleted artifact (TENETS.md D4, D5).

When an owner deletes a workspace artifact (a project, persona, document, revision,
product doc, board, request, list, conversation, company-context file …) the delete is
real, and it is RECORDED in the table that held the artifact:

- ``pk 'AUDIT#delete'`` / ``sk '{iso}#{uuid4 hex}'`` (newest last, never collides);
- ``kind`` (what was deleted, e.g. ``persona``), ``target`` (ids only, never content),
  ``actor`` (``{sub, kind}``; kind is ``user | admin | agent | mcp | plan | system``,
  never an email), ``reason`` (optional), ``deleted_at``.

The row carries no ``ttl``: an audit trail never expires. It is written with
``attribute_not_exists(pk)`` so an existing row is never overwritten.

Recording a delete never fails the delete: ``record_delete`` logs a warning (the kind
only), counts the ``DeleteRecordFailures`` metric (namespace ``VoC``) so a missing record is visible, and
returns.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from typing import Any, Final

from shared.ai_writing import PLAN_PRINCIPAL_CLAIM, PLAN_PRINCIPAL_PREFIX
from shared.api import get_caller_groups
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

__all__ = ['actor_from_event', 'record_delete']

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


def record_delete(
    table: Any,
    *,
    kind: str,
    target: Mapping[str, str],
    actor: Mapping[str, str] | None,
    reason: str | None = None,
) -> None:
    """Write one ``AUDIT#delete`` row to ``table``; never raises (see the module docstring)."""
    now = now_iso()
    item: dict[str, Any] = {
        'pk': AUDIT_PK,
        'sk': f'{now}#{uuid.uuid4().hex}',
        'kind': kind,
        'target': _texts(target),
        'actor': _texts(actor) if actor else dict(SYSTEM_ACTOR),
        'deleted_at': now,
    }
    if reason:
        item['reason'] = reason[:_MAX_TEXT]
    try:
        table.put_item(Item=item, ConditionExpression='attribute_not_exists(pk)')
    except Exception as exc:  # noqa: BLE001 - recording a delete never fails the delete
        logger.warning('Could not record a delete', extra={'kind': kind, 'error_type': type(exc).__name__})
        # Visible, not silent: a delete that went through without its record can be found and backfilled.
        metrics.add_metric(name='DeleteRecordFailures', unit='Count', value=1)
