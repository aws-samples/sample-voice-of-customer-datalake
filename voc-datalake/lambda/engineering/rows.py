"""The reads of rows in the ``voc-engineering`` table: a run's rows of a kind (``WS#<ws>#RUN#<run>`` /
``<prefix>…``), any partition's, one row, and a low-level item's values; and what every store shares
(``Refused``)."""
from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
from typing import Any

from shared.dynamo_paging import count_query, query_all

#: How far behind the tail a reader of numbered rows re-reads (the conversation, an inbox): more than the messages of a
#: run in flight at once, since two writers may commit their numbers out of order.
TAIL_WINDOW = 20


def next_after(after: int, seqs: list[int], limit: int) -> int:
    """Where a reader of numbered rows starts its next page: a full page moves on to its last seq (older rows are long
    committed); one that reached the tail to ``TAIL_WINDOW`` below its last, so the newest are read again (the reader
    keeps each once); an empty page stays at ``after``."""
    if not seqs:
        return after
    return seqs[-1] if len(seqs) == limit else max(after, seqs[-1] - TAIL_WINDOW)


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


def partition_rows(client: Any, table: str, pk: str, prefix: str) -> list[dict[str, Any]]:
    """Every row of the partition ``pk`` whose sort key starts with ``prefix``, in key order, read consistently."""
    return query_all(client, _query(table, pk, prefix))


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


class Refused(Exception):
    """An operation refused; ``kind`` names why, and its caller answers the status that goes with it."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
