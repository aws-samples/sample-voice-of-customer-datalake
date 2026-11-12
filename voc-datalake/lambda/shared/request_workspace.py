"""The workspace a domain API request acts in (docs/multi-workspace.md, "Request flow", step 3).

A domain API Lambda (settings, and each one that moves into its workspace after it) calls ``request_workspace`` first
in a route. A request that names a workspace (``X-Workspace-Id``) is resolved by shared/workspace.py
``resolve_workspace`` on the ``voc-workspaces`` table its ``WORKSPACES_TABLE`` names, with this container's 30 s
membership cache and the live platform-admin check (shared/platform_admin_gate.py ``confirm_live_platform_admin``, in
the pool ``USER_POOL_ID`` names) for an entry that would elevate. So its answers are the workspaces API's: the one 404
for a malformed id, a missing or deleting workspace, or a caller who is not a member; a platform admin enters as
admin, audited (``AUDIT#WS#{ws}``). ``fresh`` (a route that writes): resolved from the table, never from the warm
cache, so a member removed or demoted a moment ago in another container cannot write (the workspaces API's member
writes do the same; a platform admin's write is then audited as an entry each time). A DynamoDB or Cognito fault
answers ``public_error`` (500), the AWS text only in the log. The route then keys its rows with the context's
workspace (shared/workspace_settings.py for settings).

A request that names none (no header, or a blank one) gets ``None``: the deployment as before (docs/multi-workspace.md,
"Per-workspace configuration": a web app with no workspace and a deployment from before workspaces send no header).
The route then keeps its deployment-wide row and today's rules, never a
workspace's row, so a request without the header reaches no workspace's data. It goes when every deployment runs
inside a workspace (the first workspace made at bootstrap, agreed with the multi-workspace lead).

The Lambda's role attaches the stack's workspace-resolution policy (lib/utils/workspace-resolution-grants.ts, the one
list: GetItem on ``voc-workspaces``' ``WS#*`` rows and on ``AUDIT#WS#*``, an audit row read back after a retried put;
PutItem on ``AUDIT#WS#*`` only) and has Cognito ``AdminListGroupsForUser`` and ``AdminGetUser`` on the user pool.

``require_workspace_writer``: 403 for a viewer (docs/multi-workspace.md, Roles: a viewer reads, an editor writes).
``require_settings_admin``: who changes an admin's settings kind that moved into its workspace (the brand): an admin of
the workspace the request names (the deployment's ``admins`` group grants nothing there), or, for a request that names
none, the deployment's ``admins`` as before. Both branches refuse (403), so the route-gate inventory counts it as a gate
(lambda/api/test/test_route_admin_gates.py ``GATE_PRIMITIVES``).
"""
from __future__ import annotations

import os
from typing import Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import require_admin
from shared.aws import get_dynamodb_resource
from shared.exceptions import AuthorizationError, ConfigurationError, ServiceError
from shared.http_cache import request_header
from shared.logging import logger
from shared.platform_admin_gate import confirm_live_platform_admin
from shared.tables import cached_table
from shared.workspace import (
    WORKSPACE_HEADER,
    MembershipCache,
    WorkspaceContext,
    require_workspace_admin,
    resolve_workspace,
)

__all__ = ['request_workspace', 'require_settings_admin', 'require_workspace_writer']

#: The roles that write in a workspace (an editor's and an admin's; a viewer reads).
WRITER_ROLES: Final = frozenset({'editor', 'admin'})
#: This warm container's resolved memberships (30 s, shared/workspace.py).
_MEMBERSHIPS: Final = MembershipCache()


def _names_a_workspace(event: dict) -> bool:
    value = request_header(event, WORKSPACE_HEADER)
    return isinstance(value, str) and bool(value.strip())


def request_workspace(event: dict, public_error: str, *, fresh: bool = False) -> WorkspaceContext | None:
    """The workspace ``event``'s ``X-Workspace-Id`` names and the caller's role there; ``None`` when it names none
    (the deployment as before). ``fresh``: from the table, not the warm cache. See the module docstring."""
    if not _names_a_workspace(event):
        return None
    table_name = os.environ.get('WORKSPACES_TABLE', '')
    if not table_name:
        raise ConfigurationError('Workspaces table not configured')
    try:
        return resolve_workspace(cached_table(get_dynamodb_resource(), table_name), event,
                                 MembershipCache() if fresh else _MEMBERSHIPS,
                                 confirm_platform_admin=confirm_live_platform_admin)
    except (ClientError, BotoCoreError) as exc:
        # A failed read, live check or entry audit row: the entry is refused, the AWS error stays in the log.
        logger.exception('Error resolving the workspace')
        raise ServiceError(public_error) from exc


def require_workspace_writer(context: WorkspaceContext) -> None:
    """403 unless the caller writes in the workspace: an editor or an admin (a viewer reads only)."""
    if context.role not in WRITER_ROLES:
        raise AuthorizationError('Workspace editor access required')


def require_settings_admin(event: dict, context: WorkspaceContext | None) -> None:
    """403 unless the caller is an admin of the workspace the request names, or, when it names none (``context`` is
    ``None``: the deployment as before), in the deployment's ``admins`` group."""
    if context is None:
        require_admin(event)
    else:
        require_workspace_admin(context)
