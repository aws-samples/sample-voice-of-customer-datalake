"""
Radar API Lambda (voc-radar-api) - Handles /radar and /radar/{proxy+} (docs/radar.md).

Other brands, kept apart from our own feedback: everything here reads the
``voc-radar`` table, plus our aggregates for the "us" side of a comparison
(only the categories the caller may see) and the source profiles that define
the brands. Every signed-in user may read; the brand list, the scan settings
and "Scan now" are admin-only.

Routes:
    GET  /radar                                 brands (with 90-day totals), last scan, settings
    GET  /radar/brands        PUT /radar/brands (admin)
                                                the effective brands {key, label, domains, origin, sources} /
                                                replace the brand list (shared/radar_brands.py)
    GET  /radar/brands/<brand>?days=            totals, sentiment trend, love / hate themes
    GET  /radar/brands/<brand>/releases?days=   releases timeline with citations
    GET  /radar/brands/<brand>/compare?days=    per category: them against us
    GET  /radar/brands/<brand>/reviews?days=&category=&subcategory=&sentiment=&day=&cursor=&limit=
                                                the reviews themselves, newest first, paged (shared/radar_reviews.py)
    GET  /radar/brands/<brand>/reviews/<feedback_id>
                                                one review with its enrichment (the review modal)
    GET  /radar/settings      PUT /radar/settings (admin)
    POST /radar/scan (admin) -> 202, starts voc-radar-scan (the last scan is in GET /radar)

A brand is visible only when the caller may see EVERY source tracking it
(a restricted Radar source hides its brand from users without a grant); an
invisible or unknown brand is a 404.
"""

import json
import os
from collections.abc import Callable
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Final

from aws_lambda_powertools.event_handler import Response, content_types

from shared import category_access
from shared.api import api_handler, create_api_resolver, get_raw_categories_config, require_admin, validate_int
from shared.aws import get_dynamodb_resource, invoke_lambda_async
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_caller
from shared.data_version import VersionRead, bump_radar_version
from shared.exceptions import ConfigurationError, NotFoundError, ServiceError, ValidationError
from shared.logging import logger, tracer
from shared.project_gate import caller_from_event
from shared.radar_brands import BRAND_LIST_KEY, RadarBrand, effective_brands, load_brand_list, validate_brand_list
from shared.radar_counts import review_counts
from shared.radar_releases import list_releases
from shared.radar_reviews import review_detail_view, reviews_page, stored_review
from shared.radar_settings import SETTINGS_KEY, load_settings, validate_settings
from shared.radar_views import (
    brand_totals,
    compare,
    configured_category_names,
    ours_visible,
    sentiment_trend,
    themes,
    window,
)
from shared.request_body import json_body_value
from shared.response_cache import memoized_route, request_versions
from shared.source_profiles import load_source_profiles
from shared.tables import get_aggregates_table
from shared.warm_init import warm_at_init

RADAR_TABLE = os.environ.get('RADAR_TABLE', '')
RADAR_SCAN_FUNCTION = os.environ.get('RADAR_SCAN_FUNCTION', '')
LAST_SCAN_KEY: Final = {'pk': 'RADARSCAN', 'sk': 'LAST'}
DEFAULT_DAYS: Final = 90
MAX_DAYS: Final = 365
DEFAULT_RELEASE_DAYS: Final = 365
MAX_RELEASES: Final = 50
BRAND_NOT_FOUND: Final = 'Radar brand not found'
# The scan outcome the page shows (never `requested_by`).
_SCAN_TEXT_FIELDS: Final = ('status', 'mode', 'reason', 'started_at', 'finished_at')
_SCAN_COUNT_FIELDS: Final = ('brands', 'queries', 'added', 'merged')

app = create_api_resolver()


def get_radar_table() -> Any:
    """The voc-radar table resource, or 500 when the deployment did not configure it."""
    if not RADAR_TABLE:
        raise ConfigurationError('Radar table not configured')
    return _table(get_dynamodb_resource(), RADAR_TABLE)


@lru_cache(maxsize=4)
def _table(resource: Any, name: str) -> Any:
    """One ``Table`` per (resource, name): boto3 rebuilds the resource class on every ``.Table()``,
    and a request reads the table several times. Keyed on the resource, so a new one gets a new Table."""
    return resource.Table(name)


def _aggregates() -> Any:
    table = get_aggregates_table()
    if table is None:
        raise ConfigurationError('Aggregates table not configured')
    return table


def _scope() -> CategoryScope:
    """The caller's scope, resolved once per request (the resolver context is cleared after each one)."""
    scope = app.context.get('category_scope')
    if not isinstance(scope, CategoryScope):
        scope = scope_for_caller(caller_from_event(app.current_event.raw_event), _aggregates())
        app.append_context(category_scope=scope)
    return scope


def _versions() -> VersionRead:
    """Data + config (ours, for the comparison and the brands' profiles) + Radar versions: one BatchGetItem."""
    return request_versions(app, _aggregates(), get_radar_table())


def _request_scope() -> CategoryScope:
    """``_scope``, looked up at call time (a patched ``_scope`` is the one the memo keys on)."""
    return _scope()


# Opt-in warm-container memo for the read routes (shared/response_cache.py, docs/caching.md).
_memoized = memoized_route(app, scope=_request_scope, versions=_versions)


def _profiles() -> list[dict[str, Any]]:
    try:
        return load_source_profiles(_aggregates())
    except ValueError as exc:
        raise ServiceError('The source settings are invalid. Ask an admin to save them again.') from exc


def _visible_brands(scope: CategoryScope, brands: list[RadarBrand] | None = None) -> list[RadarBrand]:
    """The effective brands (the brand list, then legacy profile brands) the caller may see.

    A listed brand no profile names has no sources, so every signed-in user sees it.
    ``brands`` is the effective list when the caller already read it (read here otherwise).
    """
    return [brand for brand in (_effective_brands() if brands is None else brands)
            if all(category_access.admits_source(scope, source) for source in brand.sources)]


def _effective_brands() -> list[RadarBrand]:
    try:
        listed = load_brand_list(get_radar_table())
    except ValueError as exc:
        raise ServiceError('The Radar brand list is invalid. Ask an admin to save it again.') from exc
    return effective_brands(listed, _profiles())


def _brand(scope: CategoryScope, key: str, brands: list[RadarBrand] | None = None) -> RadarBrand:
    for brand in _visible_brands(scope, brands):
        if brand.key == key:
            return brand
    raise NotFoundError(BRAND_NOT_FOUND)


def _days(default: int = DEFAULT_DAYS) -> int:
    params = app.current_event.query_string_parameters or {}
    return validate_int(params.get('days'), default=default, min_val=1, max_val=MAX_DAYS)


def _brand_view(brand: RadarBrand) -> dict[str, Any]:
    # `sources`: the legacy profile ids naming the brand. Only a visible brand reaches here, and a
    # brand is visible only when the caller is admitted to every one of them (_visible_brands).
    return {'key': brand.key, 'label': brand.label, 'domains': list(brand.domains), 'sources': list(brand.sources),
            'origin': brand.origin}


def _counted(table: Any, brand: str, window_days: tuple[Any, Any], scope: CategoryScope, *,
             with_trend: bool) -> dict[str, Any]:
    """``{total, avg_sentiment, sentiment}`` (+ ``trend``) from the distinct reviews the list shows.

    The daily counters count every stored COPY (a file imported twice counted twice), so the
    header said 12 while "Read all reviews" listed 6. Counted from the list's own walk and the
    caller's scope instead; only a window too large to walk falls back to the counters.
    """
    start, end = window_days
    counts = review_counts(table, brand, start, end, scope)
    if counts.complete:
        view = counts.totals()
        return {**view, 'trend': counts.trend()} if with_trend else view
    view = brand_totals(table, brand, start, end)
    return {**view, 'trend': sentiment_trend(table, brand, start, end)} if with_trend else view


def _last_scan(table: Any) -> dict[str, Any] | None:
    item = table.get_item(Key=LAST_SCAN_KEY).get('Item')
    if not item:
        return None
    view: dict[str, Any] = {key: str(item[key]) for key in _SCAN_TEXT_FIELDS if key in item}
    view.update({key: int(item[key]) for key in _SCAN_COUNT_FIELDS if key in item})
    return view


@app.get('/radar')
@tracer.capture_method
@_memoized
def overview():
    """Every brand the caller may see, its 90-day totals, the last scan and the settings."""
    table = get_radar_table()
    days = window(DEFAULT_DAYS, datetime.now(UTC).date())
    scope = _scope()
    brands = [{**_brand_view(brand), **_counted(table, brand.key, days, scope, with_trend=False)}
              for brand in _visible_brands(scope)]
    return {'brands': brands, 'last_scan': _last_scan(table), 'settings': load_settings(table)}


def _admin_body(validate: Callable[[object], Any]) -> Any:
    """Admin only: the request body through ``validate`` (its ValueError is the 400)."""
    require_admin(app.current_event.raw_event)
    try:
        return validate(json_body_value(app))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _put_signed(item: dict[str, Any]) -> None:
    """Write one settings row with who saved it and when."""
    caller = caller_from_event(app.current_event.raw_event)
    get_radar_table().put_item(Item={
        **item, 'updated_at': datetime.now(UTC).isoformat(), 'updated_by': caller.username or caller.subject,
    })


@app.get('/radar/brands')
@tracer.capture_method
@_memoized
def list_brands():
    """The effective brands the caller may see: the brand list, then legacy profile brands (``origin``)."""
    return {'brands': [_brand_view(brand) for brand in _visible_brands(_scope())]}


@app.put('/radar/brands')
@tracer.capture_method
def put_brands():
    """Admin: replace the brand list (Administration -> Sources -> Radar). Stored reviews are never deleted."""
    brands = _admin_body(validate_brand_list)
    _put_signed({**BRAND_LIST_KEY, 'brands': brands})
    bump_radar_version(get_radar_table())
    logger.info('Radar brand list saved', extra={'brands': len(brands)})
    return {'success': True, **list_brands()}


@app.get('/radar/brands/<brand_key>')
@tracer.capture_method
@_memoized
def brand_detail(brand_key: str):
    """One brand's totals, daily sentiment trend and love / hate themes over ``days``."""
    scope = _scope()
    brand = _brand(scope, brand_key)
    table = get_radar_table()
    days = _days()
    start, end = window(days, datetime.now(UTC).date())
    return {
        'brand': _brand_view(brand), 'days': days,
        **_counted(table, brand.key, (start, end), scope, with_trend=True),
        **themes(table, brand.key, start, end, scope),
    }


@app.get('/radar/brands/<brand_key>/releases')
@tracer.capture_method
@_memoized
def brand_releases(brand_key: str):
    """The brand's releases filed in the last ``days`` (365 by default), newest first, with citations."""
    brand = _brand(_scope(), brand_key)
    days = _days(DEFAULT_RELEASE_DAYS)
    start, _ = window(days, datetime.now(UTC).date())
    return {'brand': _brand_view(brand), 'days': days,
            'releases': list_releases(get_radar_table(), brand.key, start, MAX_RELEASES)}


@app.get('/radar/brands/<brand_key>/compare')
@tracer.capture_method
@_memoized
def brand_compare(brand_key: str):
    """Per category (our taxonomy), the brand's sentiment and volume against ours."""
    scope = _scope()
    # ONE read of the brand list and the source profiles serves both the lookup and the sources.
    brands = _effective_brands()
    brand = _brand(scope, brand_key, brands)
    days = _days()
    start, end = window(days, datetime.now(UTC).date())
    aggregates = _aggregates()
    categories = configured_category_names(get_raw_categories_config(aggregates))
    radar_sources = [source for each in brands for source in each.sources]
    return {'brand': _brand_view(brand), 'days': days,
            **compare(get_radar_table(), aggregates, brand.key, categories, start, end, scope,
                      ours_available=ours_visible(scope, radar_sources))}


@app.get('/radar/brands/<brand_key>/reviews')
@tracer.capture_method
@_memoized
def brand_reviews(brand_key: str):
    """The brand's reviews, newest first, filtered (category, subcategory, sentiment, day) and paged."""
    scope = _scope()
    brand = _brand(scope, brand_key)
    params = app.current_event.query_string_parameters or {}
    try:
        page = reviews_page(get_radar_table(), brand.key, scope, params, window(_days(), datetime.now(UTC).date()))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return {'brand': _brand_view(brand), **page}


@app.get('/radar/brands/<brand_key>/reviews/<feedback_id>')
@tracer.capture_method
def brand_review(brand_key: str, feedback_id: str):
    """One review of the brand, with its enrichment (the review modal); 404 when absent or out of scope."""
    scope = _scope()
    brand = _brand(scope, brand_key)
    item = stored_review(get_radar_table(), brand.key, feedback_id)
    if item is None or not category_access.admits_item(scope, item):
        raise NotFoundError('Radar review not found')
    return {'brand': {'key': brand.key, 'label': brand.label}, 'review': review_detail_view(item)}


@app.get('/radar/settings')
@tracer.capture_method
def get_settings():
    return {'settings': load_settings(get_radar_table())}


@app.put('/radar/settings')
@tracer.capture_method
def put_settings():
    """Admin: cadence, max_brands, query_cap (Settings -> Radar)."""
    settings = _admin_body(validate_settings)
    _put_signed({**SETTINGS_KEY, **settings})
    bump_radar_version(get_radar_table())
    return {'success': True, 'settings': settings}


def _scan_brand_from_body(body: object, brands: list[RadarBrand]) -> str | None:
    """The one brand ``{brand}`` asks to scan (404 when not visible), or None for every brand."""
    if body is None:
        return None
    if not isinstance(body, dict):
        raise ValidationError('Request body must be a JSON object')
    key = body.get('brand')
    if key is None:
        return None
    if not isinstance(key, str):
        raise ValidationError('brand must be a Radar brand key')
    if not any(brand.key == key for brand in brands):
        raise NotFoundError(BRAND_NOT_FOUND)
    return key


@app.post('/radar/scan')
@tracer.capture_method
def start_scan():
    """Admin: "Scan now" for every brand (or ``{brand}``), ignoring the cadence; 202 while it runs."""
    require_admin(app.current_event.raw_event)
    if not RADAR_SCAN_FUNCTION:
        raise ConfigurationError('Radar scan worker not configured')
    caller = caller_from_event(app.current_event.raw_event)
    brands = _visible_brands(_scope())
    brand = _scan_brand_from_body(json_body_value(app), brands)
    if not brands:
        raise ValidationError('No Radar brand yet: add the brands to track in Administration → Sources → Radar first')
    payload: dict[str, Any] = {'mode': 'manual', 'requested_by': caller.subject}
    if brand:
        payload['brand'] = brand
    invoke_lambda_async(RADAR_SCAN_FUNCTION, payload)
    logger.info('Radar scan started', extra={'brand': brand or '*'})
    return Response(status_code=202, content_type=content_types.APPLICATION_JSON,
                    body=json.dumps({'success': True, 'status': 'started', 'brand': brand}))


# Build the AWS clients during INIT, not on the first request (shared/warm_init.py).
warm_at_init(get_dynamodb_resource)


@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
