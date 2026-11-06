"""The latest run row of a manual source or scraper run, as the status routes answer it.

Runs are aggregates-table partitions newest-first by sort key: ``SOURCE_RUN#{source}``
(``GET /sources/{source}/status``, integrations) and ``SCRAPER_RUN#{scraper_id}``
(``GET /scrapers/{id}/status``). Each route adds its own fields (pages scraped, redacted
errors) and its own read-failure answer around these.
"""

from __future__ import annotations

from typing import Any

from boto3.dynamodb.conditions import Key


def latest_run(table: Any, pk: str) -> dict | None:
    """The newest row of run partition ``pk``, or None when it never ran (boto errors propagate)."""
    response = table.query(KeyConditionExpression=Key('pk').eq(pk), ScanIndexForward=False, Limit=1)
    items = response.get('Items', [])
    return items[0] if items else None


def run_summary(run: dict) -> dict:
    """The fields every run status answer carries."""
    return {
        'execution_id': run.get('sk'),
        'status': run.get('status', 'unknown'),
        'started_at': run.get('started_at'),
        'completed_at': run.get('completed_at'),
        'items_found': run.get('items_found', 0),
    }
