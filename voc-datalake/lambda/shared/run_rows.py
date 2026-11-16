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

A source's run of ONE app (Run now on a review page or an app connector: the body's ``app_id``) keeps that
``app_id`` on its row, so ``GET /sources/status?run_status=…&app_id=…`` answers that app's newest run rather than
the plugin's (four review pages run at once each see their own), and ``&execution_id=…`` one run by its id. Both
read the request's partition only (in a workspace through its view), so another workspace's id answers
``never_run``.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any, Final

from shared.ingest_tables import table_view
from shared.scoped_query import iter_partition, query_partition
from shared.ws_repo import WorkspaceScope, scraper_run_pk, source_run_pk

__all__ = ['run_app_id_error', 'run_execution_id_error', 'run_status',
           'scraper_run_partition', 'source_run_partition']

#: The longest app a run names: a review page's URL (shared/web_review_targets.py ``MAX_URL_CHARS``; the web_reviews
#: ingestor takes a target's id or URL), an App Store id or an Android package name being far shorter.
MAX_RUN_APP_ID_CHARS: Final = 2048
#: Any printable text (a URL, a package name, an id), never a control character: the value is only ever an
#: attribute and a filter value, never a key.
_RUN_APP_ID_RE: Final = re.compile(r'[^\x00-\x1f\x7f]+')
#: A run's id as ``run_source`` mints it (shared/ids.py ``timestamped_id``: ``run_{source}_<UTC stamp>_<8 hex>``;
#: an id minted before the suffix existed has none).
_EXECUTION_ID_TAIL: Final = r'_\d{14}(?:_[0-9a-f]{8})?'
#: How many of a source's newest run rows an app's newest run is looked for among (pages of ``_APP_RUN_PAGE``): a
#: run older than that many manual runs of the plugin answers ``never_run``.
APP_RUN_LOOKBACK: Final = 200
_APP_RUN_PAGE: Final = 50


def source_run_partition(scope: WorkspaceScope | None, source: str) -> str:
    """A source's run partition: ``SOURCE_RUN#{source}``, or ``WS#{ws}#SOURCE_RUN#{source}`` in ``scope``."""
    return f'SOURCE_RUN#{source}' if scope is None else source_run_pk(scope, source)


def scraper_run_partition(scope: WorkspaceScope | None, scraper_id: str) -> str:
    """A scraper's run partition: ``SCRAPER_RUN#{id}``, or ``WS#{ws}#SCRAPER_RUN#{id}`` in ``scope``."""
    return f'SCRAPER_RUN#{scraper_id}' if scope is None else scraper_run_pk(scope, scraper_id)


def run_app_id_error(value: object) -> str | None:
    """Why ``value`` cannot name the app of a run (``app_id``), or None: 1 to ``MAX_RUN_APP_ID_CHARS`` characters
    of text without a control character."""
    if not isinstance(value, str) or not _RUN_APP_ID_RE.fullmatch(value) or len(value) > MAX_RUN_APP_ID_CHARS:
        return (f'app_id must be 1-{MAX_RUN_APP_ID_CHARS} characters without control characters: the app, '
                'package or review page the run is for')
    return None


def run_execution_id_error(source: str, value: object) -> str | None:
    """Why ``value`` cannot be the id of a run of ``source`` (``run_{source}_<stamp>_<hex>``), or None."""
    if not isinstance(value, str) or not re.fullmatch(f'run_{re.escape(source)}{_EXECUTION_ID_TAIL}', value):
        return f'execution_id must be the id of a run of {source[:40]!r}, as Run now answers it'
    return None


def latest_run(table: Any, pk: str, scope: WorkspaceScope | None = None) -> dict | None:
    """The newest row of run partition ``pk`` (in ``scope``), or None when it never ran (boto errors propagate)."""
    response = query_partition(scope, table, 'pk', pk, ScanIndexForward=False, Limit=1)
    items = response.get('Items', [])
    return items[0] if items else None


def latest_app_run(table: Any, pk: str, app_id: str, scope: WorkspaceScope | None = None) -> dict | None:
    """The newest row of run partition ``pk`` (in ``scope``) whose ``app_id`` is ``app_id``, among its
    ``APP_RUN_LOOKBACK`` newest rows, or None. Read consistently: the poll right after Run now finds its row."""
    rows = iter_partition(scope, table, 'pk', pk, max_items=APP_RUN_LOOKBACK, ScanIndexForward=False,
                          Limit=_APP_RUN_PAGE, ConsistentRead=True)
    # The newest first, at most APP_RUN_LOOKBACK rows read (the pager stops there), the first match answered.
    return next((row for row in rows if row.get('app_id') == app_id), None)


def run_by_id(table: Any, pk: str, execution_id: str, scope: WorkspaceScope | None = None) -> dict | None:
    """Row ``execution_id`` of run partition ``pk`` (in ``scope``: its view refuses another workspace's partition),
    or None. Read consistently, like :func:`latest_app_run`."""
    return table_view(scope, table).get_item({'pk': pk, 'sk': execution_id}, ConsistentRead=True).get('Item')


def _find_run(table: Any, pk: str, scope: WorkspaceScope | None, app_id: str | None,
              execution_id: str | None) -> dict | None:
    """The run a status request names: one by its id (and, with ``app_id`` too, only when it is that app's), an
    app's newest, or the partition's newest."""
    if execution_id is not None:
        run = run_by_id(table, pk, execution_id, scope)
        return run if run is not None and (app_id is None or run.get('app_id') == app_id) else None
    if app_id is not None:
        return latest_app_run(table, pk, app_id, scope)
    return latest_run(table, pk, scope)


def run_status(table: Any, pk: str, ident: Mapping[str, str], extra: Callable[[dict], dict],
               scope: WorkspaceScope | None = None, *, app_id: str | None = None,
               execution_id: str | None = None) -> dict:
    """``ident`` plus the status fields and ``extra(run)`` of the latest run (or of the run ``execution_id`` names,
    or of ``app_id``'s newest, see :func:`_find_run`); ``unknown`` without a table, ``never_run`` without a row. A
    failed read raises (the route answers it)."""
    if not table:
        return {**ident, 'status': 'unknown'}
    run = _find_run(table, pk, scope, app_id, execution_id)
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
