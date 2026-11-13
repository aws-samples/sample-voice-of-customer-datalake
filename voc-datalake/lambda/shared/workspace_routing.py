"""The workspace of a public, non-user entry point, from a server-side record (docs/multi-workspace.md, "Public and
non-user entry points"), and the one writer of a workspace on an asynchronous payload or message.

A public route has no signed-in caller, so no membership to resolve: its workspace comes from a row the platform
wrote in ``voc-workspaces``, never from what the caller sent (a header, a body or query field):

* a feedback form created in a workspace has a lookup row ``FORM#{form id}`` / ``META`` naming it (``workspace_id``,
  ``created_at``), written when the form is created (``claim_lookup``) and removed with it (``release_lookup``);
  the public config, iframe and submit routes read it first (``route_public_id``). No row: a deployment form, as
  before;
* a webhook ``POST /webhooks/{plugin}/{ws}``: the ``{ws}`` path value is only the key of the workspace's own
  ``WS#{ws}`` / ``META`` row (``route_workspace_id``); the scope is built from the row read, not from the path.

Either way the workspace must be ``active``: a row naming a malformed, unknown or ``deleting`` workspace raises
``Unroutable``, which each route answers exactly as it answers an unknown id (no oracle for which workspace owns
what). The scope is built by the layer (shared/ws_repo.py ``scope_from_lookup``) from the item this module read
itself (shared/aws.py ``consistent_item``), and a payload or message names the workspace only through
``workspace_payload``: from a request's resolved membership (a ``WorkspaceContext``) or from a ``RoutedWorkspace``,
which only this module builds. shared/test/test_ws_raw_access.py pins all three.

Reads are strongly consistent, so a deleted form or a workspace set to ``deleting`` is refused at once.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from botocore.exceptions import ClientError

from shared.aws import consistent_item, is_conditional_check_failure
from shared.platform_workspaces import CREDENTIALS_READY
from shared.workspace import ACTIVE, WorkspaceContext
from shared.workspace_ids import is_workspace_id, ws_key
from shared.ws_repo import FORM_LOOKUP_PREFIX, LOOKUP_SORT_KEY, WORKSPACE_FIELD, WorkspaceScope, scope_from_lookup

__all__ = [
    'RoutedWorkspace',
    'Unroutable',
    'claim_lookup',
    'release_lookup',
    'route_public_id',
    'route_workspace_id',
    'workspace_payload',
]

#: The attributes a workspace's ``META`` is read with: its key, its status and its secret's. The webhook role's GetItem
#: on ``WS#*`` is limited to exactly these (lib/stacks/api-stack.ts, ``dynamodb:Attributes``), so it never reads a
#: ``MEMBER#`` row's email or name.
META_ROUTING_ATTRIBUTES: Final = ('pk', 'sk', 'status', 'secret_status')


class Unroutable(Exception):
    """A lookup row, or a webhook's workspace, that routes nowhere: a malformed id, an unknown workspace or one that is
    not ``active``. The caller answers as for an unknown id, so the answer confirms nothing."""


@dataclass(frozen=True)
class RoutedWorkspace:
    """The active workspace a public entry point acts in, from a stored row. Built only by this module."""

    scope: WorkspaceScope
    #: The workspace ``META``'s ``secret_status`` (``ready`` once its credentials secret exists).
    secret_status: str = ''

    @property
    def ws(self) -> str:
        return self.scope.ws

    @property
    def secret_ready(self) -> bool:
        return self.secret_status == CREDENTIALS_READY


def lookup_key(form_id: str) -> dict[str, str]:
    """``{pk: 'FORM#{form id}', sk: 'META'}``: a workspace form's lookup row in voc-workspaces."""
    if not form_id:
        raise ValueError('not a lookup key')
    return {'pk': f'{FORM_LOOKUP_PREFIX}{form_id}', 'sk': LOOKUP_SORT_KEY}


def _routed(table: Any, ws: str) -> RoutedWorkspace:
    """The workspace ``ws`` names as a ``RoutedWorkspace``, from its own stored ``META`` row (the scope built from
    that row, never from ``ws``), when the row is there and ``active``; ``Unroutable`` otherwise."""
    meta = consistent_item(table, {'pk': ws_key(ws), 'sk': LOOKUP_SORT_KEY}, META_ROUTING_ATTRIBUTES)
    if meta is None or meta.get('status') != ACTIVE:
        raise Unroutable
    try:
        scope = scope_from_lookup(meta)
    except ValueError as error:
        raise Unroutable from error
    secret_status = meta.get('secret_status')
    return RoutedWorkspace(scope, secret_status if isinstance(secret_status, str) else '')


def route_public_id(table: Any, form_id: str) -> RoutedWorkspace | None:
    """The workspace a form id belongs to: None when it has no lookup row (a deployment form, served as before), the
    ``RoutedWorkspace`` of an active workspace, else ``Unroutable``."""
    row = consistent_item(table, lookup_key(form_id))
    if row is None:
        return None
    try:
        scope = scope_from_lookup(row)
    except ValueError as error:
        raise Unroutable from error
    return _routed(table, scope.ws)


def route_workspace_id(table: Any, ws: object) -> RoutedWorkspace:
    """The active workspace whose own ``META`` row ``ws`` is the key of (a webhook's path value: only a lookup key),
    else ``Unroutable``."""
    if not isinstance(ws, str) or not is_workspace_id(ws):
        raise Unroutable
    return _routed(table, ws)


def claim_lookup(table: Any, form_id: str, scope: WorkspaceScope, at: str) -> None:
    """Write the lookup row of a new form of ``scope`` (a conditional put: an id already routed raises the
    ``ConditionalCheckFailedException``, nothing overwritten)."""
    table.put_item(Item={**lookup_key(form_id), WORKSPACE_FIELD: scope.ws, 'created_at': at},
                   ConditionExpression='attribute_not_exists(pk)')


def release_lookup(table: Any, form_id: str, scope: WorkspaceScope) -> None:
    """Remove the lookup row of a form of ``scope``: only one that names ``scope`` (another workspace's row, or none,
    is left as it is, silently, so the answer confirms nothing)."""
    try:
        table.delete_item(Key=lookup_key(form_id), ConditionExpression='#ws = :ws',
                          ExpressionAttributeNames={'#ws': WORKSPACE_FIELD},
                          ExpressionAttributeValues={':ws': scope.ws})
    except ClientError as error:
        if not is_conditional_check_failure(error):
            raise


def workspace_payload(payload: Mapping[str, Any], source: object) -> dict[str, Any]:
    """An asynchronous payload or message on either path: an operator route's invoke payload (Run now, a web
    scraper's run), a form's submission, a webhook's delivery.

    A ``workspace_id`` among ``payload``'s fields (one a body or a source payload carried) is dropped first, so
    deployment-wide (``source`` None) it names no workspace, and otherwise ``workspace_id`` is the server's workspace,
    set after every other field. ``source`` must be a ``WorkspaceContext`` (a request's resolved membership, built only
    by shared/workspace.py and shared/workspace_members.py) or a ``RoutedWorkspace`` (a stored row's, built only
    here): anything else is a ``TypeError``, never a workspace (typed ``object`` so the check is also a type guard).
    """
    fields = {name: value for name, value in payload.items() if name != WORKSPACE_FIELD}
    if source is None:
        return fields
    if not isinstance(source, WorkspaceContext | RoutedWorkspace):
        raise TypeError('a workspace payload needs a resolved or a stored-row workspace')
    return {**fields, WORKSPACE_FIELD: source.ws}
