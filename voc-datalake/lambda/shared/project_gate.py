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
from shared.project_access import Caller, ProjectAccess
from shared.project_keys import PROJECT_GATE_STORE, require_deployment
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


def read_gate_meta(table: Any, project_id: str, *, workspace: WorkspaceScope | None = None) -> dict | None:
    """The project's META, projected to what the decision needs, or None.

    A failed read raises ServiceError (a JSON 500) rather than leaking a raw
    boto error: the gate must neither answer "missing" nor "allowed" on a
    transient failure.

    The company persona library's reserved container is never a project: it reads as
    missing here, so every gate that reads META (and every non-admin) answers it 404.

    Not per workspace yet: a ``workspace`` is refused (``NotPerWorkspaceError``), see
    ``require_project_level``.
    """
    require_deployment(workspace, PROJECT_GATE_STORE)
    if is_company_container(project_id):
        return None
    return read_gate_item(
        table, log_message='Project access read failed',
        error_message='Could not verify project access. Please retry.',
        **project_access.meta_gate_read(project_id, PROJECT_DELETION_ATTRIBUTE),
    )


def require_project_level(
    read_meta: Callable[[], dict | None],
    caller: Caller,
    level: str,
    *,
    missing_message: str = PROJECT_NOT_FOUND,
    workspace: WorkspaceScope | None = None,
) -> ProjectAccess:
    """The caller's access at ``level`` or above, else the prescribed refusal.

    Admins are decided without a read (``read_meta`` is not called), so every
    admin path costs what it did before per-project permissions existed.

    The gate is the deployment's and refuses a ``workspace`` (``NotPerWorkspaceError``): ``caller.is_admin``
    is the deployment's ``admins`` group and ``visibility: public`` grants edit to every signed-in user, so
    either would open a workspace's project to people outside it. The switch (slice 3h,
    docs/multi-workspace.md) decides a workspace's project from that workspace's own membership.
    """
    require_deployment(workspace, PROJECT_GATE_STORE)
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


def require_viewable_pin(table: Any, project_id: object, caller: Caller, *,
                         workspace: WorkspaceScope | None = None) -> str | None:
    """The optional project pin of an MCP credential (token or OAuth grant), which ``caller`` must be able to view.

    ``None`` / ``''`` = no pin. Checked for admins too (who skip the access gate), so a pin always names a
    project that exists. Raises ValidationError (malformed id), NotFoundError or AuthorizationError. Not per
    workspace yet: a ``workspace`` is refused (``NotPerWorkspaceError``), see ``require_project_level``.
    """
    require_deployment(workspace, PROJECT_GATE_STORE)
    if project_id is None or project_id == '':
        return None
    if not isinstance(project_id, str) or not LONG_OPAQUE_ID_RE.fullmatch(project_id):
        raise ValidationError('project_id is not a valid project id')
    require_project_level(lambda: read_gate_meta(table, project_id), caller, project_access.LEVEL_VIEW)
    if caller.is_admin and not read_gate_meta(table, project_id):
        raise NotFoundError(PROJECT_NOT_FOUND)
    return project_id


def require_person(event: Mapping[str, Any], refusal: str) -> Caller:
    """A real signed-in person, or 403 ``refusal``: a delegated credential cannot manage credentials."""
    caller = caller_from_event(event)
    if caller.delegated or not caller.subject:
        raise AuthorizationError(refusal)
    return caller
