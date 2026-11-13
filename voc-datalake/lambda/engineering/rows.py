"""The ``voc-engineering`` table's shared pieces: a run's partition key, the reads of rows (a run's rows of a kind,
``WS#<ws>#RUN#<run>`` / ``<prefix>…``, any partition's, one row), a low-level item's values, the tail rule of a
reader of numbered rows, and what every store shares."""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any

from botocore.exceptions import ClientError

from shared.dynamo_paging import count_query, query_all
from shared.ids import is_key_collision

#: How far below its cursor a reader of numbered rows re-reads (the conversation, an inbox): more than the messages of
#: a run in flight at once, since two writers may commit their numbers out of order.
TAIL_WINDOW = 20

#: The attribute a launch holds an agent's ``AGENT#`` row by until its session is written (runtime/sessions.py
#: ``SessionStore.hold_launch``): a row with it and no ``seq`` is a launch under way or lost, not an agent yet, so
#: every reader of agents skips it (reports/facts.py too).
LAUNCH_HOLD = 'launching_until'


def window_start(after: int) -> int:
    """Where a read of numbered rows after ``after`` starts: ``TAIL_WINDOW`` below it, on every page, so a number taken
    before the reader passed it but committed after (a full page's end as much as the tail) is still read. The reader
    keeps each row once; a read takes at most its limit plus the window."""
    return max(0, after - TAIL_WINDOW)


def window_page[T](after: int, rows: Sequence[T], limit: int, seq: Callable[[T], int]) -> list[T]:
    """A page of rows read from ``window_start(after)`` in seq order: the window's again, then at most ``limit``
    above ``after``."""
    above = [row for row in rows if seq(row) > after][:limit]
    return [*(row for row in rows if seq(row) <= after), *above]


def next_after(after: int, seqs: list[int]) -> int:
    """Where the next read's ``after`` is: the highest seq read, or ``after`` when there is none above it. Moving the
    cursor that far never skips a number still committing, since the next read starts at ``window_start`` of it."""
    return max([after, *seqs])


def run_pk(ws: str, run_id: str) -> str:
    return f'WS#{ws}#RUN#{run_id}'


def get_row(client: Any, table: str, key: Mapping[str, Any]) -> dict[str, Any] | None:
    """One row by its key, read consistently (a low-level client's item), None when it is not there."""
    return client.get_item(TableName=table, Key=key, ConsistentRead=True).get('Item')


def string_attr(item: Mapping[str, Any], key: str) -> str:
    """A low-level item's string attribute, ``''`` when it is absent."""
    return str(item.get(key, {}).get('S', ''))


def text_value(value: Any) -> str:
    """A low-level attribute value's string (``item.get('x')``), ``''`` when it is absent or not one."""
    return str(value.get('S', '')) if isinstance(value, dict) else ''


def number_value(value: Any) -> int:
    """A low-level attribute value's whole number (``item.get('x')``), 0 when it is absent or not one."""
    return int(value.get('N', '0')) if isinstance(value, dict) else 0


def _query(table: str, pk: str, prefix: str) -> dict[str, Any]:
    return {'TableName': table, 'ConsistentRead': True, 'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :p)',
            'ExpressionAttributeValues': {':pk': {'S': pk}, ':p': {'S': prefix}}}


def partition_rows(client: Any, table: str, pk: str, prefix: str, *, max_items: int | None = None) -> list[dict[str, Any]]:
    """Every row of the partition ``pk`` whose sort key starts with ``prefix``, in key order, read consistently
    (at most ``max_items`` of them when given: the read stops there)."""
    return query_all(client, _query(table, pk, prefix), max_items=max_items)


def whole_partition(client: Any, table: str, pk: str) -> list[dict[str, Any]]:
    """Every row of the partition ``pk``, in key order, read consistently, page by page (unbounded: for an erasure,
    which must reach every row)."""
    return query_all(client, {'TableName': table, 'ConsistentRead': True, 'KeyConditionExpression': 'pk = :pk',
                              'ExpressionAttributeValues': {':pk': {'S': pk}}})


def run_rows(client: Any, table: str, ws: str, run_id: str, prefix: str) -> list[dict[str, Any]]:
    """Every row of the run whose sort key starts with ``prefix``, in key order (a low-level client's items)."""
    return partition_rows(client, table, run_pk(ws, run_id), prefix)


def count_run_rows(client: Any, table: str, ws: str, run_id: str, prefix: str) -> int:
    return count_query(client, _query(table, run_pk(ws, run_id), prefix))


def amount_attr(item: Mapping[str, Any], key: str) -> Decimal:
    """A number attribute of a low-level item: 0 when missing, malformed, negative or not finite."""
    try:
        value = Decimal(str(item.get(key, {}).get('N', '0')))
    except InvalidOperation:
        return Decimal(0)
    return value if value.is_finite() and value >= 0 else Decimal(0)


def create_only(item: Mapping[str, Any], table: str) -> dict[str, Any]:
    """A transaction's Put of ``item`` that fails when its key exists (versions, logs: written once)."""
    return {'Put': {'TableName': table, 'Item': item, 'ConditionExpression': 'attribute_not_exists(pk)'}}


def transact_or_refuse(client: Any, items: list[dict[str, Any]], refused: Exception) -> None:
    """``items`` in one transaction; ``refused`` raised (from the error) when one of their conditions failed."""
    try:
        client.transact_write_items(TransactItems=items)
    except ClientError as exc:
        if not any(is_key_collision(exc, put_index=i) for i in range(len(items))):
            raise
        raise refused from exc


class Refused(Exception):
    """An operation refused; ``kind`` names why, and its caller answers the status that goes with it."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
