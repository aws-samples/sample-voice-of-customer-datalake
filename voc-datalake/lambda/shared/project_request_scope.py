"""The scope a projects API request acts in: the one seam the project routes take their workspace from
(docs/multi-workspace.md, "3h, the switch"; since 7.103.00, slice 3h-S3a).

``project_scope(event, fresh=…)`` answers a ``ProjectScope``: the request's workspace (a ``WorkspaceScope``) and the
caller's membership there (shared/workspace.py ``membership_of``, the gate's ``WorkspaceMembership``), or
``DEPLOYMENT`` (both None), the deployment's projects as before. Until the flip slice (3h-S12) it ALWAYS answers
``DEPLOYMENT``: the projects API keeps ignoring ``X-Workspace-Id``, as it always has, so nothing a route does changes.

Why projects have a seam of their own, where the other domain APIs honour the header as soon as they move: a
workspace's projects may exist only once the switch's upgrade check has passed (shared/project_scope.py
``projects_switched``), and every project route must start honouring it in the same release, so one flag turns them
all on together.

The flip is one change: ``RESOLVE`` turns on, together with the switch's reader. Then a request that names a
workspace is resolved by shared/request_workspace.py ``request_workspace`` (its answers: the one 404 for a malformed
id, an unknown or deleting workspace and a caller who is not a member; from the table, never the warm cache, when
``fresh``), with ``elevate=False``: the projects role has no live platform-admin check, so a platform admin who is not
a member gets the one 404, as in the Documents Library (shared/library_routes.py); and a request that names none stays
the deployment's. Tests turn ``RESOLVE`` on to prove the routes that take the seam are ready.

``is_workspace_member``, ``workspace_role`` and ``workspace_members``: who is a current member of the scope's workspace
and with which role (their ``MEMBER#`` rows and the workspace's status, read strongly consistent:
shared/request_workspace.py), what a project's members and its owner must be in a workspace.

``held_scope(context)``: the scope the projects API's middleware resolved for the request, as a route included from
another module reads it (its router's ``app.context``, under ``SCOPE_CONTEXT_KEY``; since 7.106.00, 3h-S3b, the
Product tab's routes). A scope's ``context`` is the resolved ``WorkspaceContext`` itself, what an asynchronous event
names its workspace from (shared/workspace_routing.py ``workspace_payload``), so the twin's workspace is always the one
the request resolved, never a field a caller sent.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

from shared.exceptions import AuthorizationError
from shared.project_access import WorkspaceMembership
from shared.request_workspace import current_members, current_role, request_workspace
from shared.workspace import WORKSPACE_FAULT, WorkspaceContext, membership_of
from shared.ws_repo import WorkspaceScope, scope_of

__all__ = ['DEPLOYMENT', 'SCOPE_CONTEXT_KEY', 'ProjectScope', 'held_scope', 'is_workspace_member', 'project_scope',
           'workspace_members', 'workspace_role']

#: Where the projects API's middleware keeps the request's ``ProjectScope`` in the resolver's context.
SCOPE_CONTEXT_KEY: Final = 'project_scope'

#: Whether the projects API resolves ``X-Workspace-Id`` at all: False until the flip (3h-S12), which turns it on in the
#: same change as the switch's reader. Never set anywhere else in production code.
RESOLVE: bool = False


@dataclass(frozen=True)
class ProjectScope:
    """Where a project request acts: ``workspace`` and the caller's ``membership`` there, both None for the
    deployment, and ``context``, the resolved ``WorkspaceContext`` they were built from (None for the deployment): what
    an asynchronous event's ``workspace_id`` is named from. Built only by ``project_scope`` (and ``DEPLOYMENT``), so the
    three always belong together."""

    workspace: WorkspaceScope | None
    membership: WorkspaceMembership | None
    context: WorkspaceContext | None = field(default=None, compare=False, repr=False)


#: The deployment's projects, as before: no workspace, no membership.
DEPLOYMENT: Final = ProjectScope(workspace=None, membership=None)


def project_scope(event: Mapping[str, Any], *, fresh: bool) -> ProjectScope:
    """The request's ``ProjectScope``: ``DEPLOYMENT`` while ``RESOLVE`` is off (today) or the request names no
    workspace; else its resolved workspace and the caller's membership (see the module docstring)."""
    if not RESOLVE:
        return DEPLOYMENT
    # A fault while resolving answers the resolver's fixed 500 (the AWS text stays in the log).
    context = request_workspace(dict(event), WORKSPACE_FAULT, fresh=fresh, elevate=False)
    if context is None:
        return DEPLOYMENT
    return ProjectScope(workspace=scope_of(context), membership=membership_of(context), context=context)


def held_scope(context: Mapping[str, Any]) -> ProjectScope:
    """The request's scope as the projects API's middleware resolved it (``context``: the resolver's or an included
    router's ``app.context``); an ``AuthorizationError`` when it is not there (unreachable: the middleware sets it for
    every routed request), never the deployment's in its place."""
    scope = context.get(SCOPE_CONTEXT_KEY)
    if not isinstance(scope, ProjectScope):
        raise AuthorizationError("The request's project scope could not be determined")
    return scope


def workspace_role(workspace: WorkspaceScope, sub: str) -> str | None:
    """``sub``'s role in ``workspace`` now (``admin``, ``editor`` or ``viewer``), or None for a non-member or a
    workspace that is not active; read strongly consistent."""
    return current_role(workspace.ws, sub) if sub else None


def is_workspace_member(workspace: WorkspaceScope, sub: str) -> bool:
    """Whether ``sub`` is a current member of ``workspace`` (read strongly consistent; any role)."""
    return workspace_role(workspace, sub) is not None


def workspace_members(workspace: WorkspaceScope, subs: Iterable[str]) -> set[str]:
    """Which of ``subs`` are current members of ``workspace``: its status read once, then each one's ``MEMBER#`` row."""
    return current_members(workspace.ws, [sub for sub in subs if sub])
