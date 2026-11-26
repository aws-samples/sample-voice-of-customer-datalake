"""voc-radar-scan: the Radar news scan (docs/radar.md).

Two ways in:

- ``{"mode": "scheduled"}`` — a daily EventBridge tick. It first lists the active workspaces (the platform's
  listing, one Query a page) and starts one asynchronous run of this function per workspace,
  ``{"mode": "scheduled", "workspace_id": ws}`` (``fan_out``), then scans the deployment's. Each scan does nothing
  (beyond a status read for a workspace's, and its settings reads) unless Radar tracks a brand there (the brand list
  in Administration -> Sources -> Radar, or a source profile naming one) AND its last scan is older than its cadence.
- ``{"mode": "manual", "brand"?: key, "requested_by"?: sub, "workspace_id"?: ws}`` — "Scan now"
  (``POST /radar/scan``, an admin's; inside a workspace its admins'), async invoke; ignores the cadence.

An event's ``workspace_id`` (``message_scope``) makes the scan that workspace's: its brands, profiles, settings, state
rows and timeline; one that is not a workspace id is refused, never scanned as the deployment's; a workspace that is
not active is not scanned, and one that stops being active mid-scan gets nothing more written.

One scan at a time per scope (a lock row with an expiry, the deployment's and each workspace's). Brands are scanned in
effective order (the brand list, then legacy profile brands), at most ``max_brands``, each with an equal share of the
``query_cap``; the scan stops early when the Lambda's time runs short. Each of a
brand's searches remembers the day it last ran, so its next date filter asks only
for what is new to THAT search, never more than 90 days back (``windows.py``).

Rows (``voc-radar``): ``RADARSCAN/LOCK``, ``RADARSCAN/LAST`` (the latest scan's
outcome, read by the Radar page), ``RADARSCAN#{brand}/STATE`` (``last_scan_at``,
``query_cursor``, where the brand's rotated query plan resumes, ``scan.py``, and
``since_by_step``, the day each search last ran, ``windows.py``); a workspace's are the same rows under
``WS#{ws}#`` (shared/radar_keys.py), with its owner list ``WS#{ws}#RADAR_OWNED`` naming each per-brand partition
before it is written (its hard delete reads it).

Sources: the AgentCore web-search gateway, Exa when an admin stored its key
(``shared.radar_exa_key``, read once per scan) and each brand's feeds. With none of the three
available the scan records ``web_search_unavailable`` and does nothing.

Env: ``RADAR_TABLE``, ``AGGREGATES_TABLE``, ``RADAR_EXA_PARAMETER``, ``WORKSPACES_TABLE`` (the tick's fan-out),
``WEB_SEARCH_GATEWAY_URL`` (optional).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any, Final

from aws_lambda_powertools.metrics import MetricUnit
from botocore.exceptions import ClientError

from jobs.radar_scan.extract import Budget, ExtractContext
from jobs.radar_scan.scan import ScanSources, scan_brand
from jobs.radar_scan.windows import BrandWindow, brand_window, next_state
from shared.aws import get_dynamodb_resource, invoke_lambda_async, is_conditional_check_failure
from shared.data_version import bump_radar_version
from shared.http_utils import fetch_public_url
from shared.invocation_cost import instrumented_handler
from shared.logging import logger, metrics
from shared.radar_brands import RadarBrand, effective_brands, load_brand_list
from shared.radar_exa_key import load_exa_key
from shared.radar_keys import brand_state_key, owned_row, scan_key
from shared.radar_releases import release_pk
from shared.radar_settings import cadence_interval, load_settings, per_brand_queries
from shared.source_profiles import load_source_profiles
from shared.timestamps import now_iso
from shared.warm_init import warm_at_init
from shared.web_search import is_web_search_configured, search_web
from shared.workspace_config import get_scoped_item
from shared.workspace_listing import active_workspaces
from shared.ws_repo import WORKSPACE_FIELD, WorkspaceScope, WorkspaceStatusCheck, message_scope, ws_table

RADAR_TABLE, AGGREGATES_TABLE = (os.environ.get(name, '') for name in ('RADAR_TABLE', 'AGGREGATES_TABLE'))
# voc-workspaces: the platform's listing of active workspaces the schedule's tick fans out to.
WORKSPACES_TABLE = os.environ.get('WORKSPACES_TABLE', '')
LOCK_SECONDS: Final = 16 * 60
# Stop starting brands when less than this is left of the 15-minute budget.
MIN_REMAINING_MS: Final = 90_000
MAX_PAGE_FETCHES: Final = 5


def _tables(*names: str) -> tuple[Any, ...]:
    """The named tables (voc-radar and voc-aggregates by default)."""
    resource = get_dynamodb_resource()
    return tuple(resource.Table(name) for name in (names or (RADAR_TABLE, AGGREGATES_TABLE)))


def _put_scan_row(table: Any, item: dict[str, Any], workspace: WorkspaceScope | None, **options: Any) -> None:
    """The deployment's ``put_item(Item=…)`` as before; a workspace's through its view (its keys checked there)."""
    if workspace is None:
        table.put_item(Item=item, **options)
    else:
        ws_table(workspace, table).put_item(item, **options)


def _claim_lock(table: Any, now: datetime, workspace: WorkspaceScope | None = None) -> bool:
    try:
        _put_scan_row(table, {**scan_key('LOCK', workspace), 'expires_at': int(now.timestamp()) + LOCK_SECONDS}, workspace,
             ConditionExpression='attribute_not_exists(pk) OR expires_at < :now',
             ExpressionAttributeValues={':now': int(now.timestamp())})
    except ClientError as e:
        if is_conditional_check_failure(e):
            return False
        raise
    return True


def _due(table: Any, cadence: str, now: datetime, workspace: WorkspaceScope | None = None) -> bool:
    last = get_scoped_item(table, scan_key('LAST', workspace), workspace)
    finished = str(last.get('finished_at') or '')
    if not finished:
        return True
    return now - datetime.fromisoformat(finished) >= cadence_interval(cadence)


def _window(table: Any, brand: RadarBrand, now: datetime, workspace: WorkspaceScope | None = None) -> BrandWindow:
    """How far back each of the brand's searches looks and where its plan resumes (``windows.py``)."""
    return brand_window(get_scoped_item(table, brand_state_key(brand.key, workspace), workspace), now.date())


def _record(table: Any, outcome: dict[str, Any], workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    """Store the scan's outcome, then bump the Radar version once: its releases and the
    page's "last scan" line are new to the cached Radar reads (docs/caching.md); the workspace's own with one."""
    _put_scan_row(table, {**scan_key('LAST', workspace), **outcome}, workspace)
    if workspace is None:
        bump_radar_version(table)
    else:
        bump_radar_version(table, workspace)
    return outcome


def _selected(brands: list[RadarBrand], event: dict[str, Any], max_brands: int) -> list[RadarBrand]:
    only = event.get('brand')
    picked = [brand for brand in brands if brand.key == only] if isinstance(only, str) and only else brands
    return picked[:max_brands]


def _scan(event: dict[str, Any], context: Any, table: Any, brands: list[RadarBrand], settings: dict[str, Any],
          sources: ScanSources, workspace: WorkspaceScope | None = None) -> dict[str, Any]:
    now = datetime.now(UTC)
    now_iso = now.isoformat()
    selected = _selected(brands, event, settings['max_brands'])
    share = per_brand_queries(settings['query_cap'], len(selected))
    pages = Budget(MAX_PAGE_FETCHES)
    totals = {'queries': 0, 'added': 0, 'merged': 0, 'brands': 0}
    for brand in selected:
        if context.get_remaining_time_in_millis() < MIN_REMAINING_MS:
            logger.warning('Radar: stopping the scan early, the time budget is nearly spent')
            break
        ctx = ExtractContext(brand=brand.key, brand_label=brand.label, domains=brand.domains,
                             today=now.date(), pages=pages, fetch=fetch_public_url,
                             search_terms=brand.search_terms)
        if workspace is not None:
            if not _workspace_active(workspace):
                raise _WorkspaceGone
            _list_owned(table, workspace, [release_pk(brand.key, workspace),
                                           brand_state_key(brand.key, workspace)['pk']])
        window = _window(table, brand, now, workspace)
        stats = scan_brand(brand, window=window, budget=Budget(share), ctx=ctx, table=table,
                           now_iso=now_iso, sources=sources, **({} if workspace is None else {'workspace': workspace}))
        _put_scan_row(table, {**brand_state_key(brand.key, workspace), 'last_scan_at': now_iso, 'query_cursor': stats.cursor,
                     'since_by_step': next_state(window, stats.ran_steps, now.date())}, workspace)
        for key in ('queries', 'added', 'merged'):
            totals[key] += getattr(stats, key)
        totals['brands'] += 1
    return totals


def _list_owned(table: Any, workspace: WorkspaceScope, partitions: list[str]) -> None:
    """Name ``partitions`` in the workspace's Radar owner list before they are written (its hard delete reads it)."""
    view = ws_table(workspace, table)
    for partition in partitions:
        view.put_item(owned_row(workspace, partition))


def _sources(brands: list[RadarBrand], workspace: WorkspaceScope | None = None) -> ScanSources | None:
    """Web search when the gateway is deployed, Exa when a key is stored, feeds; None when none is available.
    The Exa key is the deployment's, never a workspace's scan's (a workspace keeps no Exa key yet: docs/radar.md)."""
    search = search_web if is_web_search_configured() else None
    exa_key = load_exa_key() if workspace is None else None
    if search is None and not exa_key and not any(brand.feed_urls for brand in brands):
        return None
    return ScanSources(search=search, exa_key=exa_key)


def handle_event(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run (or skip) one scan; returns its outcome, also stored at ``RADARSCAN/LAST`` when it ran.

    The scan is the workspace's an event names (``workspace_id``, shared/ws_repo.py ``message_scope``: a request's
    resolved workspace, or the tick's fan-out): its brands, profiles, settings, state rows and timeline. One naming
    something that is not a workspace id is refused, never scanned as the deployment's. The schedule's tick
    (no workspace) first fans out to every active workspace (``fan_out``), then scans the deployment's as before.
    """
    refused, workspace = message_scope(event)
    if refused:
        logger.warning('Radar: a scan event names no valid workspace; refused')
        metrics.add_metric(name='RadarScanRefused', unit=MetricUnit.Count, value=1)
        return {'status': 'refused', 'reason': 'invalid_workspace'}
    mode = 'manual' if event.get('mode') == 'manual' else 'scheduled'
    if mode == 'scheduled' and workspace is None:
        fan_out()
    return _scan_in(event, context, mode, workspace)


def fan_out() -> int:
    """The schedule's tick: one asynchronous run of this function per active workspace (``{mode, workspace_id}``),
    each its own scan with its own lock, cadence and state; how many were started. A listing or an invoke that fails
    is logged and counted (``RadarScanFanOutFailures``) and never stops the deployment's scan, which runs next; the
    next tick tries again."""
    function_name = os.environ.get('AWS_LAMBDA_FUNCTION_NAME', '')
    if not (WORKSPACES_TABLE and function_name):
        logger.error('Radar: WORKSPACES_TABLE or the function name is not set; no workspace scanned on this tick')
        metrics.add_metric(name='RadarScanFanOutFailures', unit=MetricUnit.Count, value=1)
        return 0
    try:
        workspaces = active_workspaces(_tables(WORKSPACES_TABLE)[0])
    except Exception:
        logger.exception('Radar: the workspaces could not be listed; none scanned on this tick')
        metrics.add_metric(name='RadarScanFanOutFailures', unit=MetricUnit.Count, value=1)
        return 0
    started = 0
    for workspace in workspaces:
        try:
            invoke_lambda_async(function_name, {'mode': 'scheduled', WORKSPACE_FIELD: workspace.ws})
        except Exception:
            logger.exception('Radar: a workspace scan could not be started', extra={'workspace_id': workspace.ws})
            metrics.add_metric(name='RadarScanFanOutFailures', unit=MetricUnit.Count, value=1)
            continue
        started += 1
    return started


#: This container's check of a workspace's status (shared/ws_repo.py ``workspace_is_active``), built on first use.
_status: list[WorkspaceStatusCheck] = []


def _workspace_active(workspace: WorkspaceScope) -> bool:
    """Whether ``workspace`` is still active: asked before a workspace's scan writes anything and before each brand,
    as every writer of a workspace's data asks (4d-1), so a workspace being deleted gets no new Radar row. A failed read
    raises (the scan fails; the next tick tries again)."""
    if not _status:
        _status.append(WorkspaceStatusCheck(_tables(WORKSPACES_TABLE)[0]))
    return _status[0](workspace)


class _WorkspaceGone(Exception):
    """The workspace stopped being active during its scan: nothing more is written there."""


def _scan_in(event: dict[str, Any], context: Any, mode: str, workspace: WorkspaceScope | None) -> dict[str, Any]:
    if workspace is not None and not _workspace_active(workspace):
        return {'status': 'skipped', 'reason': 'workspace_not_active'}
    table, aggregates = _tables()
    brands = effective_brands(load_brand_list(table, workspace), load_source_profiles(aggregates, workspace))
    if not brands:
        return {'status': 'skipped', 'reason': 'no_brands'}
    settings = load_settings(table, workspace)
    now = datetime.now(UTC)
    if mode == 'scheduled' and not _due(table, settings['cadence'], now, workspace):
        return {'status': 'skipped', 'reason': 'not_due'}
    started = {'mode': mode, 'started_at': now.isoformat(), 'requested_by': str(event.get('requested_by') or '')}
    sources = _sources(brands, workspace)
    if sources is None:
        return _record(table, {**started, 'status': 'skipped', 'reason': 'web_search_unavailable',
                               'finished_at': now.isoformat()}, workspace)
    if not _claim_lock(table, now, workspace):
        return {'status': 'skipped', 'reason': 'already_running'}
    gone = False
    try:
        totals = _scan(event, context, table, brands, settings, sources, workspace)
        return _record(table, {**started, **totals, 'status': 'completed', 'finished_at': now_iso()}, workspace)
    except _WorkspaceGone:
        # Its hard delete runs: no outcome, no lock release (the lock expires), nothing more written there.
        gone = True
        logger.info('Radar: a workspace stopped being active during its scan; stopped')
        return {'status': 'stopped', 'reason': 'workspace_not_active'}
    except Exception:
        logger.exception('Radar scan failed')
        _record(table, {**started, 'status': 'failed', 'finished_at': now_iso()}, workspace)
        raise
    finally:
        if not gone:
            # Released by expiring it (no DeleteItem grant on the table).
            _put_scan_row(table, {**scan_key('LOCK', workspace), 'expires_at': 0}, workspace)


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
