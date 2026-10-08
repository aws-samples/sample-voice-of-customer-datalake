"""The per-project access gate shared by every Lambda that guards project data.

`shared.project_access` is the pure policy; this module is the one place that
turns a request into a decision: parse the caller from the authorizer claims,
read the project's META the same way everywhere, and raise the HTTP answer the
contract prescribes — 404 when the caller cannot view the project (no existence
leak), 403 when they can view but lack the level.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared import project_access
from shared.api import get_caller_groups
from shared.exceptions import AuthorizationError, NotFoundError, ServiceError
from shared.logging import logger
from shared.project_access import Caller, ProjectAccess
from shared.project_writes import PROJECT_DELETION_ATTRIBUTE, is_project_tombstone

PROJECT_NOT_FOUND = 'Project not found'
# No LEVEL_VIEW entry: a caller who cannot view is answered 404 before the level
# check (``can_view`` is ``allows(LEVEL_VIEW)``), so view is never refused with 403.
DENIED_MESSAGES = {
    project_access.LEVEL_EDIT: 'You do not have permission to edit this project',
    project_access.LEVEL_MANAGE: 'You do not have permission to manage this project',
}


def caller_from_event(event: Mapping[str, Any]) -> Caller:
    """The Caller for an API Gateway proxy event; fails closed (403) without a sub."""
    try:
        return project_access.caller_from_claims(
            project_access.claims_from_event(event), get_caller_groups(dict(event)),
        )
    except ValueError as exc:
        raise AuthorizationError('Caller identity could not be determined') from exc


def read_gate_meta(table: Any, project_id: str) -> dict | None:
    """The project's META, projected to what the decision needs, or None.

    A failed read raises ServiceError (a JSON 500) rather than leaking a raw
    boto error: the gate must neither answer "missing" nor "allowed" on a
    transient failure.
    """
    try:
        response = table.get_item(
            **project_access.meta_gate_read(project_id, PROJECT_DELETION_ATTRIBUTE)
        )
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Project access read failed')
        raise ServiceError('Could not verify project access. Please retry.') from exc
    item = response.get('Item') if isinstance(response, dict) else None
    return item if isinstance(item, dict) else None


def require_project_level(
    read_meta: Callable[[], dict | None],
    caller: Caller,
    level: str,
    *,
    missing_message: str = PROJECT_NOT_FOUND,
) -> ProjectAccess:
    """The caller's access at ``level`` or above, else the prescribed refusal.

    Admins are decided without a read (``read_meta`` is not called), so every
    admin path costs what it did before per-project permissions existed.
    """
    if caller.is_admin:
        return ProjectAccess(role=project_access.ROLE_ADMIN)
    meta = read_meta()
    if not meta or is_project_tombstone(meta):
        raise NotFoundError(missing_message)
    access = project_access.resolve_access(meta, caller)
    if not access.can_view:
        raise NotFoundError(missing_message)
    if not access.allows(level):
        raise AuthorizationError(DENIED_MESSAGES[level])
    return access
