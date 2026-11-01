"""voc-radar-scan: the Radar news scan (docs/radar.md).

Two ways in:

- ``{"mode": "scheduled"}`` — a daily EventBridge tick. It does nothing (and
  costs nothing beyond two settings reads) unless Radar tracks a brand (the
  brand list in Administration -> Sources -> Radar, or a legacy source profile
  naming one) AND the last scan is older than the cadence in Settings -> Radar.
- ``{"mode": "manual", "brand"?: key, "requested_by"?: sub}`` — "Scan now"
  (``POST /radar/scan``, admin), async invoke; ignores the cadence.

One scan at a time (a lock row with an expiry). Brands are scanned in
effective order (the brand list, then legacy profile brands), at most ``max_brands``, each with an equal share of the
``query_cap``; the scan stops early when the Lambda's time runs short. Each of a
brand's searches remembers the day it last ran, so its next date filter asks only
for what is new to THAT search, never more than 90 days back (``windows.py``).

Rows (``voc-radar``): ``RADARSCAN/LOCK``, ``RADARSCAN/LAST`` (the latest scan's
outcome, read by the Radar page), ``RADARSCAN#{brand}/STATE`` (``last_scan_at``,
``query_cursor``, where the brand's rotated query plan resumes, ``scan.py``, and
``since_by_step``, the day each search last ran, ``windows.py``).

Sources: the AgentCore web-search gateway, Exa when an admin stored its key
(``shared.radar_exa_key``, read once per scan) and each brand's feeds. With none of the three
available the scan records ``web_search_unavailable`` and does nothing.

Env: ``RADAR_TABLE``, ``AGGREGATES_TABLE``, ``RADAR_EXA_PARAMETER``, ``WEB_SEARCH_GATEWAY_URL`` (optional).
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any, Final

from botocore.exceptions import ClientError

from jobs.radar_scan.extract import Budget, ExtractContext
from jobs.radar_scan.scan import ScanSources, scan_brand
from jobs.radar_scan.windows import BrandWindow, brand_window, next_state
from shared.aws import get_dynamodb_resource, is_conditional_check_failure
from shared.data_version import bump_radar_version
from shared.http_utils import fetch_public_url
from shared.invocation_cost import instrumented_handler
from shared.logging import logger
from shared.radar_brands import RadarBrand, effective_brands, load_brand_list
from shared.radar_exa_key import load_exa_key
from shared.radar_settings import cadence_interval, load_settings, per_brand_queries
from shared.radar_store import LAST_SCAN_KEY
from shared.source_profiles import load_source_profiles
from shared.timestamps import now_iso
from shared.warm_init import warm_at_init
from shared.web_search import is_web_search_configured, search_web

RADAR_TABLE, AGGREGATES_TABLE = (os.environ.get(name, '') for name in ('RADAR_TABLE', 'AGGREGATES_TABLE'))
LOCK_KEY: Final = {'pk': 'RADARSCAN', 'sk': 'LOCK'}
LOCK_SECONDS: Final = 16 * 60
# Stop starting brands when less than this is left of the 15-minute budget.
MIN_REMAINING_MS: Final = 90_000
MAX_PAGE_FETCHES: Final = 5


def _tables() -> tuple[Any, Any]:
    resource = get_dynamodb_resource()
    return resource.Table(RADAR_TABLE), resource.Table(AGGREGATES_TABLE)


def _claim_lock(table: Any, now: datetime) -> bool:
    try:
        table.put_item(
            Item={**LOCK_KEY, 'expires_at': int(now.timestamp()) + LOCK_SECONDS},
            ConditionExpression='attribute_not_exists(pk) OR expires_at < :now',
            ExpressionAttributeValues={':now': int(now.timestamp())},
        )
    except ClientError as e:
        if is_conditional_check_failure(e):
            return False
        raise
    return True


def _due(table: Any, cadence: str, now: datetime) -> bool:
    last = table.get_item(Key=LAST_SCAN_KEY).get('Item') or {}
    finished = str(last.get('finished_at') or '')
    if not finished:
        return True
    return now - datetime.fromisoformat(finished) >= cadence_interval(cadence)


def _state_key(brand: RadarBrand) -> dict[str, str]:
    return {'pk': f'RADARSCAN#{brand.key}', 'sk': 'STATE'}


def _window(table: Any, brand: RadarBrand, now: datetime) -> BrandWindow:
    """How far back each of the brand's searches looks and where its plan resumes (``windows.py``)."""
    return brand_window(table.get_item(Key=_state_key(brand)).get('Item') or {}, now.date())


def _record(table: Any, outcome: dict[str, Any]) -> dict[str, Any]:
    """Store the scan's outcome, then bump the Radar version once: its releases and the
    page's "last scan" line are new to the cached Radar reads (docs/caching.md)."""
    table.put_item(Item={**LAST_SCAN_KEY, **outcome})
    bump_radar_version(table)
    return outcome


def _selected(brands: list[RadarBrand], event: dict[str, Any], max_brands: int) -> list[RadarBrand]:
    only = event.get('brand')
    picked = [brand for brand in brands if brand.key == only] if isinstance(only, str) and only else brands
    return picked[:max_brands]


def _scan(event: dict[str, Any], context: Any, table: Any, brands: list[RadarBrand], settings: dict[str, Any],
          sources: ScanSources) -> dict[str, Any]:
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
        window = _window(table, brand, now)
        stats = scan_brand(brand, window=window, budget=Budget(share), ctx=ctx, table=table,
                           now_iso=now_iso, sources=sources)
        table.put_item(Item={**_state_key(brand), 'last_scan_at': now_iso, 'query_cursor': stats.cursor,
                             'since_by_step': next_state(window, stats.ran_steps, now.date())})
        for key in ('queries', 'added', 'merged'):
            totals[key] += getattr(stats, key)
        totals['brands'] += 1
    return totals


def _sources(brands: list[RadarBrand]) -> ScanSources | None:
    """Web search when the gateway is deployed, Exa when a key is stored, feeds; None when none is available."""
    search = search_web if is_web_search_configured() else None
    exa_key = load_exa_key()
    if search is None and not exa_key and not any(brand.feed_urls for brand in brands):
        return None
    return ScanSources(search=search, exa_key=exa_key)


def handle_event(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Run (or skip) one scan; returns its outcome, also stored at ``RADARSCAN/LAST`` when it ran."""
    mode = 'manual' if event.get('mode') == 'manual' else 'scheduled'
    table, aggregates = _tables()
    brands = effective_brands(load_brand_list(table), load_source_profiles(aggregates))
    if not brands:
        return {'status': 'skipped', 'reason': 'no_brands'}
    settings = load_settings(table)
    now = datetime.now(UTC)
    if mode == 'scheduled' and not _due(table, settings['cadence'], now):
        return {'status': 'skipped', 'reason': 'not_due'}
    started = {'mode': mode, 'started_at': now.isoformat(), 'requested_by': str(event.get('requested_by') or '')}
    sources = _sources(brands)
    if sources is None:
        return _record(table, {**started, 'status': 'skipped', 'reason': 'web_search_unavailable',
                               'finished_at': now.isoformat()})
    if not _claim_lock(table, now):
        return {'status': 'skipped', 'reason': 'already_running'}
    try:
        totals = _scan(event, context, table, brands, settings, sources)
        return _record(table, {**started, **totals, 'status': 'completed', 'finished_at': now_iso()})
    except Exception:
        logger.exception('Radar scan failed')
        _record(table, {**started, 'status': 'failed', 'finished_at': now_iso()})
        raise
    finally:
        # Released by expiring it (no DeleteItem grant on the table).
        table.put_item(Item={**LOCK_KEY, 'expires_at': 0})


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@instrumented_handler
def lambda_handler(event: dict, context: Any) -> dict:
    return handle_event(event, context)
