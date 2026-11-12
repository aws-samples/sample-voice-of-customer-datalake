"""The workspace a data-path API request acts in, on either of its two paths (docs/multi-workspace.md,
"Request flow").

The read and edit routes of the data path (``/feedback/*``, ``/metrics/*``; lambda/api/metrics_handler.py and
lambda/api/feedback_edit_handler.py) serve both paths until phase 2's last slice:

* a request that sends ``X-Workspace-Id`` acts in that workspace, as shared/workspace.py ``resolve_workspace``
  decides: 400 for an empty header, the one 404 for a malformed id, an unknown or ``deleting`` workspace and a caller
  who is not a member (the deployment's ``admins`` group included); a platform admin enters as admin once the live
  check confirms them (shared/platform_admin.py), the entry audited ``AUDIT#WS#{ws}``. Every read and write of the
  request then goes through shared/ws_repo.py ``ws_table`` on the workspace's partitions;
* a request that sends no such header acts deployment-wide, exactly as before.

A header that is there but names no workspace is never read as "no header": the request is refused, not served
deployment-wide (the rule the ingestors and the processor keep for a message's ``workspace_id``).

A DynamoDB or Cognito fault while resolving answers a fixed 500 (shared/workspace.py ``WORKSPACE_FAULT``), never the
AWS text, which is logged; nothing is read for the request. Reads use the warm container's membership cache (30 s);
a write resolves the caller's role from the table (``fresh``).
"""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from shared.aws import get_cognito_idp_client
from shared.exceptions import ConfigurationError, ServiceError
from shared.http_cache import request_header
from shared.logging import logger
from shared.platform_admin import live_platform_admin_check
from shared.tables import get_workspaces_table
from shared.workspace import WORKSPACE_FAULT, WORKSPACE_HEADER, MembershipCache, WorkspaceContext, resolve_workspace
from shared.ws_repo import WorkspaceScope, scope_of

__all__ = ['RequestWorkspace']


def names_a_workspace(event: dict) -> bool:
    """Whether the request sent ``X-Workspace-Id`` at all (empty or not): it then acts in a workspace or is refused."""
    return request_header(event, WORKSPACE_HEADER) is not None


def _workspaces_table() -> Any:
    table = get_workspaces_table()
    if table is None:
        raise ConfigurationError('Workspaces table not configured')
    return table


def _user_pool() -> str:
    user_pool = os.environ.get('USER_POOL_ID', '')
    if not user_pool:
        raise ConfigurationError('User pool not configured')
    return user_pool


#: The live platform-admin check (shared/platform_admin.py); a Cognito fault raises.
_confirm_platform_admin = live_platform_admin_check(get_cognito_idp_client, _user_pool)


class RequestWorkspace:
    """One API Lambda's resolution of a request's workspace (its warm container's membership cache)."""

    def __init__(self, *, table: Callable[[], Any] = _workspaces_table,
                 confirm_platform_admin: Callable[[dict], bool] = _confirm_platform_admin,
                 memberships: MembershipCache | None = None) -> None:
        self._table = table
        self._confirm = confirm_platform_admin
        self.memberships = memberships if memberships is not None else MembershipCache()

    def context(self, event: dict, *, fresh: bool = False) -> WorkspaceContext | None:
        """The resolved membership, or None for a request that names no workspace (see the module docstring).

        ``fresh`` (a write: the feedback edits): resolved from the table, never from the 30 s warm cache, so a
        member demoted or removed a moment ago in another container cannot write with the old role (the members
        routes do the same; a platform admin's write is then audited as an entry each time).
        """
        if not names_a_workspace(event):
            return None
        memberships = MembershipCache() if fresh else self.memberships
        try:
            return resolve_workspace(self._table(), event, memberships, confirm_platform_admin=self._confirm)
        except (ClientError, BotoCoreError) as exc:
            # A failed read, a failed live platform-admin check or an entry audit row that could not be written:
            # the request is refused, the AWS error stays in the log.
            logger.exception('Error resolving the workspace of a data request')
            raise ServiceError(WORKSPACE_FAULT) from exc

    def scope(self, event: dict) -> WorkspaceScope | None:
        """The request's ``WorkspaceScope`` (``scope_of`` its resolved membership), or None deployment-wide."""
        context = self.context(event)
        return scope_of(context) if context is not None else None
