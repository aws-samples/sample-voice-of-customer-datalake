"""A configuration row of one workspace, or of the deployment (docs/multi-workspace.md, "Per-workspace configuration").

The categories, the dimensions and the source profiles are each workspace's (decision 6): ``WS#{ws}#SETTINGS#{kind}``
/ ``config`` in voc-aggregates, read through shared/ws_repo.py ``ws_table`` (so a key outside the workspace never
reaches DynamoDB). Without a workspace (``scope`` None: a request that names none, the deployment-wide data path) the
kind's deployment row, ``SETTINGS#{kind}`` / ``config``, as before. Each kind's owner module keeps its deployment key
and calls this with its kind: shared/category_gate.py and shared/categorization.py (categories),
shared/dimension_config.py (dimensions), shared/source_profiles.py (sources).

No reader passes a workspace yet, and the settings routes still edit the deployment's rows: today every review flows
through the deployment-wide data path, so the categories that classify it and the PII rule, retention and restriction
of its source must be the ones an administrator edits. The phase-2 cut-over moves both together: the processor, the
ingestion paths and the feedback routes pass the scope of what they handle (shared/ws_repo.py ``scope_of``,
``scope_from_message``), and the routes then write a workspace's rows.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from shared.workspace_settings import settings_key
from shared.ws_repo import WorkspaceScope, ws_table

__all__ = ['get_config_item', 'get_scoped_item']


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
