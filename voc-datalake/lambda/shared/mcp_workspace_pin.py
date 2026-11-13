"""The workspace an MCP credential is created in (docs/mcp.md, "Who a token acts as"; docs/multi-workspace.md).

A personal token (``POST /connect/tokens``) and an OAuth sign-in (``POST /connect/oauth/consent``) made inside a
workspace act in it: the request's ``X-Workspace-Id`` is resolved here with the person's own membership
(shared/request_workspace.py, fresh, and without a platform admin's elevation: the credential's calls carry no group,
so only a member's would work), and the credential's row records it (shared/mcp_global_tokens.py
``WORKSPACE_ATTRIBUTE``). A platform admin who is not a member is refused with ``NOT_A_MEMBER`` (403) rather than
handed a credential that could never work; anyone else not a member gets the one 404. A request that names no
workspace makes a deployment-wide credential, as before.
"""
from __future__ import annotations

from typing import Final

from shared.exceptions import AuthorizationError, NotFoundError
from shared.platform_admin import is_platform_admin
from shared.request_workspace import request_workspace

__all__ = ['pinned_workspace']

NOT_A_MEMBER: Final = ('Only a member of an existing workspace can create a token or approve a sign-in for it: open '
                       'the workspace from your list and add yourself as a member first')


def pinned_workspace(event: dict, public_error: str) -> str | None:
    """The workspace a credential created by ``event`` acts in, or None for a deployment-wide one (see above)."""
    try:
        context = request_workspace(event, public_error, fresh=True, elevate=False)
    except NotFoundError as exc:
        if is_platform_admin(event):
            raise AuthorizationError(NOT_A_MEMBER) from exc
        raise
    return None if context is None else context.ws
