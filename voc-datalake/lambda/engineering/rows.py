"""The one read of a run's rows of a kind in the ``voc-engineering`` table: ``WS#<ws>#RUN#<run>`` / ``<prefix>…``."""
from __future__ import annotations

from typing import Any

from shared.dynamo_paging import count_query, query_all


def run_pk(ws: str, run_id: str) -> str:
    return f'WS#{ws}#RUN#{run_id}'


def _query(table: str, ws: str, run_id: str, prefix: str) -> dict[str, Any]:
    return {'TableName': table, 'ConsistentRead': True, 'KeyConditionExpression': 'pk = :pk AND begins_with(sk, :p)',
            'ExpressionAttributeValues': {':pk': {'S': run_pk(ws, run_id)}, ':p': {'S': prefix}}}


def run_rows(client: Any, table: str, ws: str, run_id: str, prefix: str) -> list[dict[str, Any]]:
    """Every row of the run whose sort key starts with ``prefix``, in key order (a low-level client's items)."""
    return query_all(client, _query(table, ws, run_id, prefix))


def count_run_rows(client: Any, table: str, ws: str, run_id: str, prefix: str) -> int:
    return count_query(client, _query(table, ws, run_id, prefix))
