"""Radar's reads of one partition, the deployment's or one workspace's (decision 13; docs/multi-workspace.md).

A workspace's Radar rows, and the counters of its own feedback that Radar compares against, sit in its partitions:
the deployment's key with the workspace's prefix, ``WS#{ws}#`` + ``RADAR#{brand}#…``, ``RELEASE#{brand}`` or
``METRIC#…`` (``scoped_pk``; shared/ws_repo.py ``metric_pk`` builds the same for the metrics). ``partition_query``
hands a reader one partition with the ``table.query(**kwargs)`` shape its pager calls, on shared/ingest_tables.py
``table_view``: the table itself without a workspace, its ``ws_table`` view with one, which refuses, before DynamoDB,
a partition or a cursor outside the workspace. Both build the key condition the same way
(shared/ws_repo.py ``partition_query``); the reader adds its own options (order, page size, cursor, projection) and
pages as it did.

No reader passes a workspace yet: Radar's routes, the brief and the processor stay the deployment's and move together
at the phase-2 cut-over (shared/radar_keys.py).
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final

from shared.ingest_tables import table_view
from shared.scoped_keys import scoped_pk
from shared.ws_repo import WorkspaceScope

__all__ = ['SortRange', 'partition_query', 'scoped_key']

#: The sort key's placeholder (``sk`` is spelled through a name, as the layer spells ``pk``).
_SK: Final = '#radar_sk'


def scoped_key(workspace: WorkspaceScope | None, key: Mapping[str, str]) -> dict[str, str]:
    """A ``{pk, sk}`` key with its partition in ``workspace`` (``scoped_pk``)."""
    return {**key, 'pk': scoped_pk(workspace, key['pk'])}


@dataclass(frozen=True)
class SortRange:
    """The sort keys to read: ``low`` to ``high`` inclusive, or from ``low`` on when ``high`` is None."""

    low: str
    high: str | None = None

    def expression(self) -> tuple[str, dict[str, str]]:
        """The sort condition and its values (its name is ``_SK``)."""
        if self.high is None:
            return f'{_SK} >= :radar_low', {':radar_low': self.low}
        return f'{_SK} BETWEEN :radar_low AND :radar_high', {':radar_low': self.low, ':radar_high': self.high}


class _Partition:
    """One partition of a table view (``table_view``), with the ``table.query(**kwargs)`` shape the pagers call."""

    def __init__(self, view: Any, pk: str, sort: SortRange | None) -> None:
        self._view = view
        self._pk = pk
        self._sort = sort

    def query(self, **kwargs: Any) -> dict:
        condition = None
        if self._sort is not None:
            condition, values = self._sort.expression()
            kwargs['ExpressionAttributeNames'] = {**(kwargs.get('ExpressionAttributeNames') or {}), _SK: 'sk'}
            kwargs['ExpressionAttributeValues'] = {**(kwargs.get('ExpressionAttributeValues') or {}), **values}
        return self._view.query('pk', self._pk, sort_condition=condition, **kwargs)


def partition_query(table: Any, workspace: WorkspaceScope | None, pk: str, sort: SortRange | None = None) -> Any:
    """Partition ``pk`` (already the workspace's, ``scoped_pk``) of ``table`` in ``sort``'s range, as an object whose
    ``query(**options)`` reads one page. A workspace's ``pk`` outside it raises ``OutOfScopeError`` on the first
    query, before DynamoDB."""
    return _Partition(table_view(workspace, table), pk, sort)
