"""Reading a project's partition in voc-projects, on either path (phase 3 plumbing, docs/multi-workspace.md).

The one read every project store makes of a whole partition, ``PROJECT#{id}`` (``WS#{ws}#PROJECT#{id}`` in a
workspace), maybe narrowed to a sort-key prefix, every page. Each page is shared/scoped_query.py
``query_partition``, bound to the partition with ``functools.partial`` for shared/dynamo_paging.py's pager (its one
``query(**kwargs)`` call): without a workspace it sends exactly the request the stores always sent
(``Key('pk').eq(…) & Key('sk').begins_with(…)`` on the table itself), in one it goes through shared/ws_repo.py
``ws_table`` (a partition or a cursor outside the workspace is refused before DynamoDB). The stores' single-item
calls go through shared/ingest_tables.py ``table_view`` and shared/workspace_config.py ``get_scoped_item``, their
transactions through shared/project_writes.py ``transact_project_writes``. Only voc-projects is read here: the jobs
and the participant lists are not per workspace yet. ``iter_registered_project_ids`` pages a workspace's registry of
its project ids the same way (since 7.26.00), ``iter_version_rows`` a project's document-version partition (since
7.27.00).
"""
from __future__ import annotations

from collections.abc import Iterator
from functools import partial
from types import SimpleNamespace
from typing import Any

from shared.dynamo_paging import iter_query
from shared.project_keys import project_pk, project_registry_pk, version_partition_key
from shared.scoped_query import SortRange, query_partition
from shared.ws_repo import WorkspaceScope, require_scope

__all__ = ['iter_project_rows', 'iter_registered_project_ids', 'iter_version_rows']


def _iter_partition(table: Any, partition: str, sort_prefix: str | None, kwargs: dict[str, Any], *,
                    workspace: WorkspaceScope | None) -> Iterator[dict]:
    sort = SortRange('sk', 'begins_with', sort_prefix) if sort_prefix is not None else None
    pages = SimpleNamespace(query=partial(query_partition, workspace, table, 'pk', partition, sort=sort))
    return iter_query(pages, kwargs)


def iter_project_rows(table: Any, project_id: str, *, workspace: WorkspaceScope | None = None,
                      sort_prefix: str | None = None, **kwargs: Any) -> Iterator[dict]:
    """Every row of the project's partition (the workspace's project when given), only those whose ``sk`` begins
    with ``sort_prefix`` when given, across every page. ``kwargs``: the rest of the Query
    (``ProjectionExpression``, ``ExpressionAttributeNames``, ``ConsistentRead``…)."""
    return _iter_partition(table, project_pk(project_id, workspace=workspace), sort_prefix, kwargs,
                           workspace=workspace)


def iter_version_rows(table: Any, project_id: str, *, workspace: WorkspaceScope | None = None,
                      sort_prefix: str | None = None, **kwargs: Any) -> Iterator[dict]:
    """``iter_project_rows`` of the project's document-version partition (shared/project_keys.py
    ``version_partition_key``: its series counters, allocations, legacy assignments and revisions; since 7.27.00)."""
    return _iter_partition(table, version_partition_key(project_id, workspace=workspace), sort_prefix, kwargs,
                           workspace=workspace)


def iter_registered_project_ids(table: Any, *, workspace: WorkspaceScope) -> Iterator[str]:
    """The id of every project made in ``workspace``, from its registry (``WS#{ws}#PROJECT_IDS``), across every page:
    a strongly consistent Query through ``ws_table``, projected to the ids. Every id the workspace ever claimed is
    there (the claim is written in the registry row's own transaction). For the export, the delete and an erasure. A
    workspace only: the deployment's projects have no registry (``OutOfScopeError`` for anything but a
    ``WorkspaceScope``)."""
    require_scope(workspace, 'only a workspace has a project registry')
    pages = SimpleNamespace(query=partial(query_partition, workspace, table, 'pk', project_registry_pk(workspace)))
    return (str(row['sk']) for row in iter_query(pages, {'ProjectionExpression': 'sk', 'ConsistentRead': True}))
