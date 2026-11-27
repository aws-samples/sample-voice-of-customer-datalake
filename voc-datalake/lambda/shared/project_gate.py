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

from shared import project_access
from shared.api import get_caller_groups
from shared.company_personas import is_company_container
from shared.exceptions import AuthorizationError, NotFoundError, ValidationError
from shared.gate_reads import read_gate_item
from shared.project_access import Caller, ProjectAccess, WorkspaceMembership
from shared.project_writes import PROJECT_DELETION_ATTRIBUTE, is_project_tombstone
from shared.row_ids import LONG_OPAQUE_ID_RE
from shared.ws_repo import WorkspaceScope

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


def acts_as_admin(caller: Caller) -> bool:
    """True for an admin acting for themselves (a delegated credential never is one)."""
    return caller.is_admin and not caller.delegated


def require_admin_caller(caller: Caller) -> None:
    """403 unless ``caller`` is an admin acting for themselves.

    A delegated (MCP) credential is never an admin, whatever its minter is.
    """
    if caller.delegated or not caller.is_admin:
        raise AuthorizationError('Admin access required')


def read_gate_meta(table: Any, project_id: str, *, workspace: WorkspaceScope | None) -> dict | None:
    """The project's META, projected to what the decision needs, or None.

    A failed read raises ServiceError (a JSON 500) rather than leaking a raw
    boto error: the gate must neither answer "missing" nor "allowed" on a
    transient failure.

    The company persona library's reserved container is never a project: it reads as
    missing here, so every gate that reads META (and every non-admin) answers it 404.

    The scope's ``META``: the deployment's ``PROJECT#{id}``, or ``WS#{ws}#PROJECT#{id}`` in a workspace (never
    the other's, so an id of another scope reads as missing).
    """
    if is_company_container(project_id):
        return None
    return read_gate_item(
        table, log_message='Project access read failed',
        error_message='Could not verify project access. Please retry.',
        **project_access.meta_gate_read(project_id, PROJECT_DELETION_ATTRIBUTE, workspace=workspace),
    )


def require_project_level(
    read_meta: Callable[[], dict | None],
    caller: Caller,
    level: str,
    *,
    missing_message: str = PROJECT_NOT_FOUND,
    workspace: WorkspaceScope | None,
    membership: WorkspaceMembership | None,
) -> ProjectAccess:
    """The caller's access at ``level`` or above, else the prescribed refusal.

    The deployment's project (``workspace`` None, no ``membership``): the deployment's admins are decided
    without a read (``read_meta`` is not called), so every admin path costs what it did before per-project
    permissions existed.

    A workspace's project (since 7.101.00, slice 3h-S2): decided from ``membership``, the caller's membership of
    that workspace as the route resolved it (shared/workspace.py ``membership_of``; any other, or none, is a
    ``WorkspaceMembershipError``, a 500, as is a read ``META`` of another scope). The deployment's ``admins`` group
    grants nothing there. A caller ``project_access.workspace_admits`` does not admit (a non-member, an agent) is
    answered the one 404 before any read, so the answer and its cost are those of a missing project; a member's is
    decided on the read ``META``, the workspace admin's too, so a missing or tombstoned project is a 404 for them as
    well. ``membership`` is required beside ``workspace`` (``membership=None`` for the deployment).
    """
    project_access.require_membership(caller, workspace=workspace, membership=membership)
    if membership is None:
        if caller.is_admin:
            return ProjectAccess(role=project_access.ROLE_ADMIN)
    elif not project_access.workspace_admits(caller, membership):
        raise NotFoundError(missing_message)
    meta = read_meta()
    if not meta or is_project_tombstone(meta):
        raise NotFoundError(missing_message)
    access = project_access.resolve_access(meta, caller, workspace=workspace, membership=membership)
    if not access.can_view:
        raise NotFoundError(missing_message)
    if not access.allows(level):
        raise AuthorizationError(DENIED_MESSAGES[level])
    return access


def require_viewable_pin(table: Any, project_id: object, caller: Caller, *,
                         workspace: WorkspaceScope | None,
                         membership: WorkspaceMembership | None) -> str | None:
    """The optional project pin of an MCP credential (token or OAuth grant), which ``caller`` must be able to view.

    ``None`` / ``''`` = no pin. Checked for the deployment's admins too (who skip the access gate), so a pin
    always names a project that exists. Raises ValidationError (malformed id), NotFoundError or
    AuthorizationError. In a workspace, ``membership`` decides it as in ``require_project_level``, whose read
    already proves the project is there (a workspace admin's included).
    """
    project_access.require_membership(caller, workspace=workspace, membership=membership)
    if project_id is None or project_id == '':
        return None
    if not isinstance(project_id, str) or not LONG_OPAQUE_ID_RE.fullmatch(project_id):
        raise ValidationError('project_id is not a valid project id')
    require_project_level(lambda: read_gate_meta(table, project_id, workspace=workspace), caller,
                          project_access.LEVEL_VIEW, workspace=workspace, membership=membership)
    if membership is None and caller.is_admin and not read_gate_meta(table, project_id, workspace=workspace):
        raise NotFoundError(PROJECT_NOT_FOUND)
    return project_id


def require_person(event: Mapping[str, Any], refusal: str) -> Caller:
    """A real signed-in person, or 403 ``refusal``: a delegated credential cannot manage credentials."""
    caller = caller_from_event(event)
    if caller.delegated or not caller.subject:
        raise AuthorizationError(refusal)
    return caller
