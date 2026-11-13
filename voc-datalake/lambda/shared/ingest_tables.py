"""The tables a plugin ingestor run reads and writes, on either of its two paths (docs/multi-workspace.md).

* A run in a workspace (its event names ``workspace_id``) sees every data-path table through the workspace layer,
  ``shared/ws_repo.py`` ``ws_table``: a key outside the workspace is refused before any call.
* A run without one (the API's Run now and reprocess, an S3 upload's trigger, the scheduled tick's own run) keeps
  the deployment-wide path it always had: the same calls on the table itself (``DeploymentTable``), with the
  deployment-wide keys the caller builds. That path stays until phase 2's last slice moves the API, the S3 trigger
  and the processor onto workspaces, and is then removed.

``DeploymentTable`` has ``WorkspaceTable``'s call shape (a key or item positional, the rest as boto3 keywords, and
``query`` building the key condition), so one ingestor body serves both paths. The one place either path opens a
table by name is here (``ingest_table``; shared/test/test_ws_raw_access.py counts it), voc-workspaces included
(the control plane: a ``DeploymentTable`` whose ``table`` the tick's fan-out pages itself). A workspace's export
(the workspaces API's export routes and the export job, phase 4) opens its views of voc-feedback and voc-aggregates
here too, always with a scope.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, overload

from shared.ws_repo import WorkspaceScope, WorkspaceTable, partition_query, ws_table

__all__ = ['DeploymentTable', 'ingest_table', 'table_view', 'update_with_key']


class DeploymentTable:
    """A table on the deployment-wide path: ``WorkspaceTable``'s call shape, no scope (``scope`` is None)."""

    scope = None

    def __init__(self, table: Any) -> None:
        self._table = table

    @property
    def table(self) -> Any:
        """The boto3 table itself, for a reader that pages with its own calls (voc-workspaces' ``PLUGIN#`` list)."""
        return self._table

    def get_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        return self._table.get_item(Key=dict(key), **kwargs)

    def put_item(self, item: Mapping[str, Any], **kwargs: Any) -> dict:
        return self._table.put_item(Item=dict(item), **kwargs)

    def update_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        return self._table.update_item(Key=dict(key), **kwargs)

    def delete_item(self, key: Mapping[str, Any], **kwargs: Any) -> dict:
        return self._table.delete_item(Key=dict(key), **kwargs)

    def query(self, partition_attribute: str, partition: str, *, sort_condition: str | None = None,
              **kwargs: Any) -> dict:
        """One page of a Query of ``partition``, the request built as ``WorkspaceTable.query`` builds it."""
        return self._table.query(**partition_query(partition_attribute, partition, sort_condition, kwargs))


@overload
def ingest_table(scope: None, resource: Any, name: str, key: str = 'pk') -> DeploymentTable: ...


@overload
def ingest_table(scope: WorkspaceScope, resource: Any, name: str, key: str = 'pk') -> WorkspaceTable: ...


@overload
def ingest_table(scope: WorkspaceScope | None, resource: Any, name: str,
                 key: str = 'pk') -> WorkspaceTable | DeploymentTable: ...


def ingest_table(scope: WorkspaceScope | None, resource: Any, name: str,
                 key: str = 'pk') -> WorkspaceTable | DeploymentTable:
    """The table ``name`` for a run in ``scope`` (``ws_table``), or for a deployment-wide run (``scope`` None)."""
    return table_view(scope, resource.Table(name), key)


def update_with_key(view: WorkspaceTable | DeploymentTable, request: Mapping[str, Any]) -> dict:
    """An ``update_item`` request built the boto3 way (``Key=`` among its arguments: shared/source_updates.py,
    shared/feedback_category.py, the aggregator's counters) sent through ``view``, whose key is positional."""
    return view.update_item(request['Key'], **{name: value for name, value in request.items() if name != 'Key'})


def table_view(scope: WorkspaceScope | None, table: Any, key: str = 'pk') -> WorkspaceTable | DeploymentTable:
    """An already-open ``table`` on either path: seen through ``scope`` (``ws_table``: a key, item or update outside
    it is refused before DynamoDB), or deployment-wide (``scope`` None, the same calls on the table). The feedback
    processor's view of its module-level tables, one message at a time."""
    return DeploymentTable(table) if scope is None else ws_table(scope, table, key)
