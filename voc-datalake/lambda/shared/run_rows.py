"""The run rows of a manual source or scraper run, on either path (docs/multi-workspace.md), as the routes write
and answer them.

Runs are aggregates-table partitions newest-first by sort key: ``SOURCE_RUN#{source}`` (``POST /sources/{source}/run``,
``GET /sources/status?run_status=``, integrations) and ``SCRAPER_RUN#{scraper_id}`` (``POST /scrapers/{id}/run``,
``GET /scrapers/{id}/status``) deployment-wide; in a workspace (a request that sends ``X-Workspace-Id``) the
workspace's ``WS#{ws}#SOURCE_RUN#{source}`` and ``WS#{ws}#SCRAPER_RUN#{scraper_id}`` (shared/ws_repo.py
``source_run_pk`` / ``scraper_run_pk``), the very partitions a plugin ingestor's run in that workspace moves
(plugins/_shared/base_ingestor.py, plugins/webscraper). Every workspace read and write goes through ``ws_table``.
Each route adds its own fields (pages scraped, redacted errors) and keeps its own read-failure answer and log line
around :func:`run_status`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from shared.scoped_query import query_partition
from shared.ws_repo import WorkspaceScope, scraper_run_pk, source_run_pk

__all__ = ['run_status', 'scraper_run_partition', 'source_run_partition']


def source_run_partition(scope: WorkspaceScope | None, source: str) -> str:
    """A source's run partition: ``SOURCE_RUN#{source}``, or ``WS#{ws}#SOURCE_RUN#{source}`` in ``scope``."""
    return f'SOURCE_RUN#{source}' if scope is None else source_run_pk(scope, source)


def scraper_run_partition(scope: WorkspaceScope | None, scraper_id: str) -> str:
    """A scraper's run partition: ``SCRAPER_RUN#{id}``, or ``WS#{ws}#SCRAPER_RUN#{id}`` in ``scope``."""
    return f'SCRAPER_RUN#{scraper_id}' if scope is None else scraper_run_pk(scope, scraper_id)


def latest_run(table: Any, pk: str, scope: WorkspaceScope | None = None) -> dict | None:
    """The newest row of run partition ``pk`` (in ``scope``), or None when it never ran (boto errors propagate)."""
    response = query_partition(scope, table, 'pk', pk, ScanIndexForward=False, Limit=1)
    items = response.get('Items', [])
    return items[0] if items else None


def run_status(table: Any, pk: str, ident: Mapping[str, str], extra: Callable[[dict], dict],
               scope: WorkspaceScope | None = None) -> dict:
    """``ident`` plus the latest run's status fields and ``extra(run)``; ``unknown`` without a
    table, ``never_run`` without a row. A failed read raises (the route answers it)."""
    if not table:
        return {**ident, 'status': 'unknown'}
    run = latest_run(table, pk, scope)
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
