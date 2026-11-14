"""One Query of one partition of a data-path table, on either path (docs/multi-workspace.md).

The read routes (lambda/api/metrics_handler.py, the channel index, the feedback edits) query an index partition
(``DATE#…``, ``CATEGORY#…``, ``URGENCY#…``, ``FEEDBACK#…``, ``CHANNEL#…``, a counter's ``METRIC#…`` or a
``metric_type``) and maybe a sort-key range:

* deployment-wide (``scope`` None): exactly the request they always sent, the key condition built with boto3's
  ``Key`` (``Key(partition).eq(…) & Key(sort).gte(…)``), on the table itself;
* in a workspace: through shared/ws_repo.py ``ws_table``, which builds the key condition itself (``#p = :p AND
  <sort>``) and refuses, before DynamoDB, a partition outside the workspace and a cursor (``ExclusiveStartKey``,
  a client's ``next_token`` among them) whose partitions are not the workspace's.

The partition is the caller's, built with shared/feedback_partitions.py or shared/metric_keys.py for the same
scope, so the two paths read the same index and differ only in the key's prefix.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from boto3.dynamodb.conditions import ConditionBase, Key

from shared.ws_repo import OutOfScopeError, WorkspaceScope, ws_table

__all__ = ['SortRange', 'query_partition']

#: The placeholders of a sort-key range on the workspace path (boto3 generates ``#n…`` / ``:v…``; the layer's own
#: are ``#p`` / ``:p``; a projection's ``#pf…``).
_SORT_NAME = '#sk'
_SORT_VALUES = (':sk0', ':sk1')
#: Every placeholder the workspace path names itself: a caller's own of the same spelling is refused, never merged.
_OWN_NAMES = frozenset({'#p', _SORT_NAME})
_OWN_VALUES = frozenset({':p', *_SORT_VALUES})


@dataclass(frozen=True)
class SortRange:
    """A sort-key condition: ``attribute >= low`` (``gte``), ``attribute BETWEEN low AND high`` (``between``) or
    ``begins_with(attribute, low)`` (``begins_with``)."""

    attribute: str
    op: Literal['gte', 'between', 'begins_with']
    low: str
    high: str = ''

    def condition(self) -> ConditionBase:
        """The boto3 condition the deployment-wide path ANDs to its partition's."""
        key = Key(self.attribute)
        if self.op == 'begins_with':
            return key.begins_with(self.low)
        return key.gte(self.low) if self.op == 'gte' else key.between(self.low, self.high)

    def expression(self) -> tuple[str, dict[str, str], dict[str, str]]:
        """``(expression, names, values)`` for the workspace layer's ``sort_condition``."""
        low, high = _SORT_VALUES
        if self.op == 'begins_with':
            return f'begins_with({_SORT_NAME}, {low})', {_SORT_NAME: self.attribute}, {low: self.low}
        if self.op == 'gte':
            return f'{_SORT_NAME} >= {low}', {_SORT_NAME: self.attribute}, {low: self.low}
        return (f'{_SORT_NAME} BETWEEN {low} AND {high}', {_SORT_NAME: self.attribute},
                {low: self.low, high: self.high})


def _refuse_own_placeholders(request: dict[str, Any]) -> None:
    """A caller's ``#p`` / ``#sk`` / ``:p`` / ``:sk0`` / ``:sk1`` would be overwritten by the workspace path's own:
    refused (``OutOfScopeError``) before DynamoDB, so a caller's projection or filter never reads another attribute."""
    names = set(request.get('ExpressionAttributeNames') or ()) & _OWN_NAMES
    values = set(request.get('ExpressionAttributeValues') or ()) & _OWN_VALUES
    if names or values:
        raise OutOfScopeError(f'placeholders reserved by the workspace query: {", ".join(sorted(names | values))}')


def query_partition(scope: WorkspaceScope | None, table: Any, partition_attribute: str, partition: str, *,
                    sort: SortRange | None = None, **kwargs: Any) -> dict:
    """One page of a Query of ``partition`` (and ``sort``) of ``table``: deployment-wide or in ``scope`` (see the
    module docstring). ``kwargs`` are the rest of the Query (``IndexName``, ``Limit``, ``FilterExpression``, a
    projection, ``ExclusiveStartKey``, ``Select``…)."""
    if scope is None:
        key = Key(partition_attribute).eq(partition)
        return table.query(KeyConditionExpression=key & sort.condition() if sort is not None else key, **kwargs)
    request = dict(kwargs)
    _refuse_own_placeholders(request)
    sort_condition = None
    if sort is not None:
        sort_condition, names, values = sort.expression()
        request['ExpressionAttributeNames'] = {**(request.get('ExpressionAttributeNames') or {}), **names}
        request['ExpressionAttributeValues'] = {**(request.get('ExpressionAttributeValues') or {}), **values}
    return ws_table(scope, table).query(partition_attribute, partition, sort_condition=sort_condition, **request)
