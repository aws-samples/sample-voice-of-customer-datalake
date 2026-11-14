"""A configuration row of one workspace, or of the deployment (docs/multi-workspace.md, "Per-workspace configuration").

The categories, the dimensions and the source profiles are each workspace's (decision 6): ``WS#{ws}#SETTINGS#{kind}``
/ ``config`` in voc-aggregates, read and written through shared/ws_repo.py ``ws_table`` (so a key outside the
workspace never reaches DynamoDB). Without a workspace (``scope`` None: a request that names none, a message that
names none) the kind's deployment row, ``SETTINGS#{kind}`` / ``config``, as before. Each kind's owner module keeps its
deployment key and calls this with its kind: shared/category_gate.py and shared/categorization.py (categories),
shared/dimension_config.py (dimensions), shared/source_profiles.py (sources); the settings API writes with
``put_config_item``.

Since the phase-2 cut-over (7.08.00) both directions are per workspace: the processor and the ingestion paths pass the
scope of the feedback they handle (shared/ws_repo.py ``scope_from_message``, a routed workspace's scope), the feedback
routes pass the request's (``scope_of``), and the six settings routes write the workspace's rows for its admins. A
workspace that has not saved a kind reads nothing of it (``{}``): the deployment's row is never its default, so what a
workspace's page shows is exactly what its own pipeline applies (the brand's rule, 6.18.00).
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope, ws_table

__all__ = ['get_config_item', 'get_scoped_item', 'put_config_item']


def _config_key(kind: str, deployment_key: Mapping[str, str], scope: WorkspaceScope | None) -> dict[str, str]:
    """The workspace's row of ``kind``; the deployment's (``deployment_key``) without a scope."""
    return dict(deployment_key) if scope is None else settings_key(scope.ws, kind)


def get_config_item(table: Any, kind: str, deployment_key: Mapping[str, str], scope: WorkspaceScope | None,
                    *, consistent: bool = True) -> dict[str, Any]:
    """The stored row of ``kind`` (``{}`` when absent). A DynamoDB error propagates."""
    # A strong read asks for it; an eventual one passes no option (DynamoDB's default).
    options = {'ConsistentRead': True} if consistent else {}
    return get_scoped_item(table, _config_key(kind, deployment_key, scope), scope, **options)


def get_scoped_item(table: Any, key: Mapping[str, str], scope: WorkspaceScope | None,
                    **options: Any) -> dict[str, Any]:
    """The stored row at ``key`` (``{}`` when absent): through the workspace's view of ``table`` when ``scope`` is
    given (a key outside it raises ``OutOfScopeError`` before DynamoDB), else on the table itself. A DynamoDB error
    propagates."""
    if scope is None:
        response = table.get_item(Key=dict(key), **options)
    else:
        response = ws_table(scope, table).get_item(key, **options)
    item = response.get('Item') if isinstance(response, Mapping) else None
    return item if isinstance(item, dict) else {}


def put_config_item(table: Any, kind: str, deployment_key: Mapping[str, str], scope: WorkspaceScope | None,
                    fields: Mapping[str, Any]) -> dict[str, Any]:
    """Replace the row of ``kind`` with ``fields`` (the workspace's through ``ws_table``, the deployment's without a
    scope) and return the item written. ``fields`` naming ``pk`` or ``sk`` is a ValueError: the key is this module's.
    A DynamoDB error propagates."""
    if 'pk' in fields or 'sk' in fields:
        raise ValueError('the key of a configuration row is not a field')
    item = {**_config_key(kind, deployment_key, scope), **fields}
    if scope is None:
        table.put_item(Item=item)
    else:
        ws_table(scope, table).put_item(item)
    return item
