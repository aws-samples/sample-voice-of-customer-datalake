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

The operator routes that start and watch ingestion (lambda/api/integrations_handler.py,
lambda/api/scrapers_handler.py) serve both paths the same way, through one shared ``ResolvedRoutes`` (their resolver
middleware, admin gate, stored credentials and Radar refusal); its rules:

* ``ResolvedRoutes.require_request_admin``: an admin-only route's gate on either path: the deployment's ``admins`` group without
  the header, the caller's admin role in the workspace with it (a member admin or an entered platform admin; the
  deployment's ``admins`` group grants nothing inside a workspace);
* ``workspace_payload`` (shared/workspace_routing.py): the one way a request-facing module names a workspace on an asynchronous invoke payload,
  from the request's RESOLVED membership (a ``WorkspaceContext``, which only shared/workspace.py and
  shared/workspace_members.py build), set after every other field, so a body's ``workspace_id`` never chooses it;
* ``ResolvedRoutes.refuse_radar_brand``: a workspace cannot save a Radar brand (Radar is not keyed by workspace; the processor would
  refuse every message it stamped);
* ``deployment_only``: the resolver middleware of a module that does not act in a workspace yet
  (lambda/api/s3_import_handler.py): a request that sends the header is refused with one fixed 400 before anything
  is read, whoever sends it, so the answer confirms no workspace.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared.api import get_caller_subject, require_admin
from shared.aws import get_cognito_idp_client
from shared.exceptions import ConfigurationError, ServiceError, ValidationError
from shared.http_cache import request_header
from shared.logging import logger
from shared.platform_admin import live_platform_admin_check
from shared.tables import get_workspaces_table
from shared.workspace import (
    WORKSPACE_FAULT,
    WORKSPACE_HEADER,
    MembershipCache,
    WorkspaceContext,
    require_workspace_admin,
    resolve_workspace,
)
from shared.workspace_plugin_store import CredentialsStore, StoreClients, credentials_store
from shared.ws_repo import WorkspaceScope, scope_of

__all__ = [
    'RequestWorkspace',
    'ResolvedRoutes',
    'deployment_only',
]

#: The one answer of a module that does not act in a workspace yet to a request that sends ``X-Workspace-Id``.
DEPLOYMENT_ONLY: Final = ('This API acts deployment-wide only, not in a workspace yet: '
                          'send the request without X-Workspace-Id.')


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


#: Where ``ResolvedRoutes.middleware`` keeps a request's resolved membership on its resolver's context.
WORKSPACE_CONTEXT_KEY: Final = 'workspace_context'
WORKSPACE_NOT_RESOLVED: Final = 'Could not open the workspace. Please retry.'


#: Radar is not keyed by workspace (phase 3): the processor refuses a workspace's message stamped with a brand.
RADAR_NOT_IN_WORKSPACES: Final = ('Radar is not keyed by workspace yet: a workspace cannot name a Radar brand. '
                                  'Save this without radar_brand, or send the request without X-Workspace-Id.')


class WorkspaceNotResolved(ServiceError):
    """A programming error: a route reached without its module's ``ResolvedRoutes.middleware`` (a fixed 500)."""


class ResolvedRoutes:
    """One two-path operator module's view of each request (the integrations and scrapers APIs), the one
    implementation both share: its resolver middleware (``middleware``, installed with
    ``app.use(middlewares=[_request.middleware])``), its admin gate (``require_request_admin``), and what the routes
    read of the current request: its membership as the middleware kept it, its scope and its stored plugin settings
    (shared/workspace_plugin_store.py: the shared secret deployment-wide, the workspace's own parameters in a
    workspace)."""

    def __init__(self, resolver: Any, workspace: RequestWorkspace | None = None,
                 clients: Callable[[], StoreClients] | None = None) -> None:
        self._resolver = resolver
        #: The module's resolution of a request's workspace (its warm container's memberships, 30 s).
        self.workspace = workspace if workspace is not None else RequestWorkspace()
        #: The module's shared secret and clients (shared/workspace_plugin_store.py), read at each ``credentials``; a
        #: module sets it right after installing the resolver (``_request.clients = lambda: StoreClients(...)``).
        self.clients = clients

    def middleware(self, resolver: Any, next_middleware: Callable[[Any], Any]) -> Any:
        """Before every route of the module: the request's membership is resolved (or refused: 400, the one 404, a
        fixed 500), afresh for each request, and kept on the resolver's context for that request only (Powertools
        clears it after each one). A read may use the 30 s membership cache; any other method resolves the role
        from the table (``fresh``), so a member demoted a moment ago cannot write."""
        event = resolver.current_event
        context = self.workspace.context(event.raw_event, fresh=event.http_method != 'GET')
        resolver.append_context(**{WORKSPACE_CONTEXT_KEY: context})
        return next_middleware(resolver)

    def require_request_admin(self) -> None:
        """The admin gate of a route that serves both paths (403 otherwise).

        Deployment-wide (no header) the deployment's ``admins`` group, as before (shared/api.py ``require_admin``).
        In a workspace the caller's role there (shared/workspace.py ``require_workspace_admin``: a member admin, or
        a platform admin who entered, live-checked and audited); the deployment's ``admins`` group grants nothing
        inside a workspace (docs/multi-workspace.md, Roles).
        """
        context = self.context()
        if context is None:
            require_admin(self._resolver.current_event.raw_event)
        else:
            require_workspace_admin(context)

    def context(self) -> WorkspaceContext | None:
        """The membership the current request acts in (None: deployment-wide), as ``middleware`` kept it. Fails
        closed (``WorkspaceNotResolved``) when the middleware did not run: never resolves the header again
        (Powertools keeps the last event after a request, so that could be an EARLIER request's) and never falls
        back to deployment-wide."""
        if WORKSPACE_CONTEXT_KEY not in self._resolver.context:
            raise WorkspaceNotResolved(WORKSPACE_NOT_RESOLVED)
        return self._resolver.context[WORKSPACE_CONTEXT_KEY]

    def scope(self) -> WorkspaceScope | None:
        context = self.context()
        return scope_of(context) if context is not None else None

    def credentials(self, *plugins: str) -> CredentialsStore:
        """The request's stored plugin settings of ``plugins`` (validated plugin ids; none: every plugin, read only):
        the shared secret deployment-wide, the resolved workspace's own in a workspace, named from that membership
        only (``ConfigurationError`` when what it needs is not configured). The module's ``clients`` are read at
        each call, so a module's own names (and its tests' stand-ins) are the ones used. A saved config list is
        stamped with the caller's sub from the request's authorizer claims (``get_caller_subject``), never a body
        field; read only when a list is saved."""
        if self.clients is None:
            raise ConfigurationError('Secrets not configured')
        event = self._resolver.current_event.raw_event
        return credentials_store(self.context(), self.clients(), plugins, actor=lambda: get_caller_subject(event))

    def credentials_or_none(self, *plugins: str) -> CredentialsStore | None:
        """``credentials`` for a read route, or None where none is configured: it then answers an empty list, as
        before."""
        try:
            return self.credentials(*plugins)
        except ConfigurationError:
            return None

    def refuse_radar_brand(self, radar_brand: object) -> None:
        """400 (``RADAR_NOT_IN_WORKSPACES``) for a non-empty Radar brand saved in a workspace: the processor would
        refuse every message it stamps (``WorkspaceRadarRefusedError``, then the DLQ), so the save is refused."""
        if self.context() is not None and radar_brand:
            raise ValidationError(RADAR_NOT_IN_WORKSPACES)


def deployment_only(app: Any, next_middleware: Callable[[Any], Any]) -> Any:
    """Resolver middleware of a module that does not act in a workspace yet: a request that sends
    ``X-Workspace-Id`` (empty or not) is refused with ``DEPLOYMENT_ONLY`` (400) before anything is read, never served
    deployment-wide (the rule of the module docstring). One answer for every caller: it confirms no workspace."""
    if names_a_workspace(app.current_event.raw_event):
        raise ValidationError(DEPLOYMENT_ONLY)
    return next_middleware(app)
