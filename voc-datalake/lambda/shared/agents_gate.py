"""Who administers the agents of a request's scope (7.80.00, docs/multi-workspace.md, the project plan 3g3-a).

``require_agents_admin(event, context)``, the agents and workflows routes' write gate (lambda/api/agents_handler.py
and the pause and resume of shared/agents_engineering_registry_routes.py): with ``context`` (the workspace the request
names, shared/request_workspace.py ``request_workspace``) an admin of that workspace acting as themselves, never the
deployment's ``admins`` group and never a delegated caller (an MCP token, an agent or a plan step acting for the
person); without one, the agents API's gate before workspaces, an admin of the deployment acting for themselves
(shared/project_gate.py ``require_admin_caller``). Both branches refuse (403), so the route-gate inventory counts it as
a gate (lambda/api/test/test_route_admin_gates.py ``GATE_PRIMITIVES``, which pins its shape).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final

from shared.exceptions import AuthorizationError
from shared.project_gate import caller_from_event, require_admin_caller
from shared.workspace import WorkspaceContext, require_workspace_admin

__all__ = ['FAILED_WORKSPACE', 'require_agents_admin']

#: What an agents route answers when the workspace the request names could not be resolved (a DynamoDB fault).
FAILED_WORKSPACE: Final = 'Failed to open the agents'


def require_agents_admin(event: Mapping[str, Any], context: WorkspaceContext | None) -> None:
    """403 unless the caller administers the agents of the request's scope (the module docstring)."""
    if context is None:
        require_admin_caller(caller_from_event(event))
    else:
        _require_workspace_agents_admin(event, context)


def _require_workspace_agents_admin(event: Mapping[str, Any], context: WorkspaceContext) -> None:
    """403 unless the caller is an admin of ``context``'s workspace acting as themselves."""
    require_workspace_admin(context)
    if caller_from_event(event).delegated:
        raise AuthorizationError("A workspace's agents cannot be changed by a delegated caller")
