"""The latest run row of a manual source or scraper run, as the status routes answer it.

Runs are aggregates-table partitions newest-first by sort key: ``SOURCE_RUN#{source}``
(``GET /sources/status?run_status=``, integrations) and ``SCRAPER_RUN#{scraper_id}``
(``GET /scrapers/{id}/status``). Each route adds its own fields (pages scraped, redacted
errors) and keeps its own read-failure answer and log line around :func:`run_status`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from boto3.dynamodb.conditions import Key


def latest_run(table: Any, pk: str) -> dict | None:
    """The newest row of run partition ``pk``, or None when it never ran (boto errors propagate)."""
    response = table.query(KeyConditionExpression=Key('pk').eq(pk), ScanIndexForward=False, Limit=1)
    items = response.get('Items', [])
    return items[0] if items else None


def run_status(table: Any, pk: str, ident: Mapping[str, str], extra: Callable[[dict], dict]) -> dict:
    """``ident`` plus the latest run's status fields and ``extra(run)``; ``unknown`` without a
    table, ``never_run`` without a row. A failed read raises (the route answers it)."""
    if not table:
        return {**ident, 'status': 'unknown'}
    run = latest_run(table, pk)
    if run is None:
        return {**ident, 'status': 'never_run'}
    return {
        **ident,
        'execution_id': run.get('sk'),
        'status': run.get('status', 'unknown'),
        'started_at': run.get('started_at'),
        'completed_at': run.get('completed_at'),
        'items_found': run.get('items_found', 0),
        **extra(run),
    }
