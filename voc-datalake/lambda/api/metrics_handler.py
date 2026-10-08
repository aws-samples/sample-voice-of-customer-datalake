"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access
from shared.api import (
    DATE_BASIS_REVIEW,
    DEFAULT_CATEGORIES,
    SEARCH_QUERY_MIN_LENGTH,
    api_handler,
    create_api_resolver,
    get_configured_categories,
    resolve_window_days,
    validate_date_basis,
    validate_days,
    validate_int,
    validate_limit,
)
from shared.aws import get_dynamodb_resource
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_event
from shared.concurrency import concurrently, ordered_map
from shared.dimension_config import allowed_values, load_dimensions_config
from shared.exceptions import ConfigurationError, ValidationError
from shared.feedback import (
    PERSONA_PREFIX,
    basis_date,
    has_legacy_persona_buckets,
    persona_bucket,
    window_cutoff,
)
from shared.github_metrics import GITHUB_SOURCE, github_breakdown, issue_attributes, matches_issue_filters
from shared.indexes import (
    AGGREGATES_BY_METRIC_TYPE_INDEX,
    FEEDBACK_BY_CATEGORY_INDEX,
    FEEDBACK_BY_DATE_INDEX,
    FEEDBACK_BY_ID_INDEX,
    FEEDBACK_BY_URGENCY_INDEX,
)
from shared.item_filters import ItemFilters, parse_item_filters
from shared.logging import logger, tracer
from shared.time_budget import WalkBudget, budgeted_days

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table

# Pagination bounds for /feedback. The candidate window is a function of
# offset+limit, capped to prevent unbounded DynamoDB scans. The cap also defines
# the maximum paginable depth.
MAX_FEEDBACK_OFFSET = 5000
MIN_CANDIDATE_CAP = 100

# Per-day GSI query page size for date-windowed scans. Used by /feedback,
# /feedback/entities, /feedback/search, and the source-filtered branches of
# /metrics/sentiment and /metrics/categories.
DATE_QUERY_LIMIT = 500

# Soft cap on accumulated candidates when iterating across days for endpoints
# that aggregate or sample feedback (entities, search, source-filtered metrics).
CANDIDATES_SOFT_CAP = 1000

# Hard ceiling on rows examined per date partition when paging with
# LastEvaluatedKey, so a huge backfill can't make one request run forever.
# Matches shared/feedback.py's MAX_ITEMS_PER_PARTITION rationale.
MAX_SCANNED_PER_PARTITION = 10000

# /feedback/urgent hydrates its GSI rows with BatchGetItem (issue #267 item 2):
# 100 keys is the API's per-request ceiling, and a throttled table may keep
# answering UnprocessedKeys, so the retry is bounded and backs off.
BATCH_GET_MAX_KEYS = 100
BATCH_GET_ATTEMPTS = 4
BATCH_GET_BACKOFF_SECONDS = 0.05

# With a post-filter (sentiment, category, review basis, category scope) most
# GSI rows may be dropped, so read this many candidates per requested item.
URGENT_FILTERED_OVERFETCH = 5

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None


def _feedback_table() -> 'Table':
    """The feedback table; ConfigurationError when FEEDBACK_TABLE is unset."""
    if feedback_table is None:
        raise ConfigurationError('Feedback table not configured')
    return feedback_table


def _aggregates_table() -> 'Table':
    """The aggregates table; ConfigurationError when AGGREGATES_TABLE is unset."""
    if aggregates_table is None:
        raise ConfigurationError('Aggregates table not configured')
    return aggregates_table

# API resolver with standard CORS
app = create_api_resolver()


# ============================================
# Date-basis helpers
# ============================================
#
# Every feedback item carries two dates:
#   - `date` (YYYY-MM-DD): when the item was processed into the data lake.
#     This backs gsi1-by-date and all pre-computed aggregates ("imported").
#   - `source_created_at` (ISO timestamp): when the customer originally wrote
#     the feedback on the source platform ("review").
#
# A review can never be imported before it was written, so at date granularity
# `date(source_created_at) <= date`. That means the import-date window queried
# via gsi1-by-date always CONTAINS every item whose review date falls in the
# same window — review-basis filtering is a post-filter over the same window,
# with no extra GSI required.


def _query_partition(
    index_name: str,
    key_expr,
    max_matched: int,
    source: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Page one GSI partition via LastEvaluatedKey.

    Returns ``(items, has_more)``. A single query returns at most one page
    (bounded by DynamoDB's 1MB / the Limit parameter), so without paging a
    partition dominated by one source starves in-memory filters for every
    other source (issue #99). When ``source`` is given it is applied as a
    server-side FilterExpression, so matching rows are found no matter how
    deep they sit in the partition.

    Paging stops once ``max_matched`` matching rows are collected or
    ``MAX_SCANNED_PER_PARTITION`` rows have been examined.
    """
    matched: list[dict[str, Any]] = []
    scanned = 0
    last_key = None
    has_more = False
    while True:
        kwargs: dict[str, Any] = {
            'IndexName': index_name,
            'KeyConditionExpression': key_expr,
            'Limit': DATE_QUERY_LIMIT,
            'ScanIndexForward': False,
        }
        if source:
            kwargs['FilterExpression'] = Attr('source_platform').eq(source)
        if last_key:
            kwargs['ExclusiveStartKey'] = last_key
        response = _feedback_table().query(**kwargs)
        matched.extend(response.get('Items', []))
        scanned += response.get('ScannedCount', len(response.get('Items', [])))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
        if len(matched) >= max_matched or scanned >= MAX_SCANNED_PER_PARTITION:
            has_more = True
            break
    return matched[:max_matched], has_more


@tracer.capture_method
def _scan_recent_items(
    days: int,
    per_day_limit: int | None = None,
    soft_cap: int = MAX_FEEDBACK_OFFSET,
    source: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Collect items imported in the last `days` days via gsi1-by-date.

    Returns ``(items, is_partial)``. ``is_partial`` is True when the scan
    was truncated (a day partition had more matching rows than the budget
    allowed, or the soft cap ended the scan with days still unread) — i.e.
    the result is a sample, not the complete window.

    Each day partition is paged (see :func:`_query_partition`); ``source``
    is pushed down as a server-side filter so dominated partitions can't
    starve source-filtered results. ``per_day_limit`` bounds each day for
    sampling callers (search); by default a day may use the entire
    remaining budget. The default ``soft_cap`` matches ``/feedback``'s
    candidate cap so list totals and metric totals agree on the same window.

    The walk is also bounded by the request's wall-clock budget
    (:func:`_walk_budget`): when it runs out the scan stops, ``is_partial`` is
    True, and the route publishes ``partial_reason``/``scanned_through``.
    """
    items: list[dict[str, Any]] = []
    is_partial = False
    budget = _walk_budget()
    for i, date in enumerate(budgeted_days(days, budget)):
        remaining = soft_cap - len(items)
        day_items, day_has_more = _query_partition(
            FEEDBACK_BY_DATE_INDEX,
            Key('gsi1pk').eq(f'DATE#{date}'),
            max_matched=min(per_day_limit, remaining) if per_day_limit else remaining,
            source=source,
        )
        items.extend(day_items)
        is_partial = is_partial or day_has_more
        if len(items) >= soft_cap:
            if i < days - 1:
                is_partial = True
            break
    return items, is_partial or budget.stopped


def _scan_window_items(
    days: int, date_basis: str, source: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Collect items whose basis date falls within the last `days` days.

    Returns ``(items, is_partial)`` — see :func:`_scan_recent_items`.

    For 'imported' this is the raw gsi1-by-date window. For 'review' the same
    window is post-filtered down to items actually written within it (see the
    containment note above).
    """
    items, is_partial = _scan_recent_items(days, source=source)
    if date_basis == DATE_BASIS_REVIEW:
        cutoff = window_cutoff(days)
        items = [i for i in items if basis_date(i, date_basis) >= cutoff]
    return items, is_partial


def _caller_scope() -> CategoryScope:
    """The caller's category scope, read once per invocation.

    Cached on the resolver context, which Powertools clears after every
    `resolve`, so a warm container never reuses one caller's scope for another.
    """
    scope = app.context.get('category_scope')
    if not isinstance(scope, CategoryScope):
        scope = scope_for_event(app.current_event.raw_event, aggregates_table)
        app.append_context(category_scope=scope)
    return scope


def _scoped_window_items(
    days: int, date_basis: str, scope: CategoryScope, source: str | None = None,
    extra: ItemFilters | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """:func:`_scan_window_items`, then the caller's category filter (and ``extra``).

    A filter STEP over the window scan rather than a change to it: the scan's
    budget and partial flag are untouched, and a restricted caller sees exactly
    the in-scope subset of what an unrestricted caller would.
    """
    items, is_partial = _scan_window_items(days, date_basis, source=source)
    items = extra.filter(items) if extra is not None else items
    return category_access.filter_items(scope, items), is_partial


def _query_metric_window(
    pk: str, days: int, current_date: datetime
) -> tuple[list[dict], bool]:
    """Read one metric partition's trailing `days` window, newest date first.

    Returns ``(items, truncated)`` — the same shape, and the same meaning of the
    second element, as :func:`_scan_recent_items` and :func:`_scan_window_items`,
    so a caller that may take either the aggregates path or the scan path ORs one
    kind of flag rather than reconciling two conventions.

    `sk` is 'YYYY-MM-DD' and ISO dates sort lexicographically, so a window is a
    contiguous sort-key range that `between()` bounds server-side: a fixed
    number of requests regardless of `days`, not one `get_item` per day.

    `ScanIndexForward=False` is load-bearing. Callers hand these items straight
    to the client as `daily_totals` / `daily_sentiment`, which are charted
    newest-first; DynamoDB's default ascending order would reverse both series
    while leaving every total correct.

    Not the `gsi1-by-metric-type` index: it only holds items the aggregator tags
    with `metric_type`, which is just the daily_source and persona partitions.
    These `pk`s are known anyway, so the base table answers directly and bounds
    the window server-side instead of reading all dates and filtering in memory.
    """
    oldest = (current_date - timedelta(days=days - 1)).strftime('%Y-%m-%d')
    newest = current_date.strftime('%Y-%m-%d')
    condition = Key('pk').eq(pk) & Key('sk').between(oldest, newest)
    items: list[dict] = []
    kwargs: dict = {'KeyConditionExpression': condition, 'ScanIndexForward': False}
    # A 365-day window of counter items sits far inside one 1 MB page today, but
    # that rests on item width the aggregator controls. So follow the cursor --
    # but bounded, never `while True`: one date yields at most one item and an
    # unfiltered page yields at least one, so a window of `days` dates cannot
    # span more than `days` pages. A bound also means a surprising response
    # shape degrades to a short read instead of spinning.
    for _ in range(days):
        response = _aggregates_table().query(**kwargs)
        items.extend(response.get('Items', []))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            return items, False
        kwargs['ExclusiveStartKey'] = last_key
    # Exhausting the bound with a cursor still open means the invariant above no
    # longer holds, so the window really is partial. This used to be logged and
    # nothing more, on the argument that "nothing in the response shape can
    # express that" -- which was false even then: six response sites in this file
    # publish `is_partial`, and they were publishing a hardcoded False on this
    # path. The flag is now RETURNED as well as logged, so an endpoint reporting a
    # short read says so to its caller instead of only to CloudWatch.
    logger.warning(
        'Metric window paging hit its bound; returning a partial window',
        extra={'pk': pk, 'days': days, 'items': len(items)},
    )
    return items, True


def _walk_budget() -> WalkBudget:
    """This request's wall-clock budget for per-day `gsi1-by-date` walks.

    One per request, shared by every walk the request makes: `lambda_handler`
    seeds it into the resolver's routing context, which Powertools clears after
    each `resolve`. Created lazily when absent (a route resolved without going
    through `lambda_handler`), so a walk is never unbudgeted.
    """
    budget = app.context.get('walk_budget')
    if not isinstance(budget, WalkBudget):
        budget = WalkBudget()
        app.append_context(walk_budget=budget)
    return budget


def _walk_partial_fields() -> dict[str, str]:
    """`{partial_reason: 'time_budget', scanned_through}` if a walk hit the budget, else `{}`.

    Spread into every response a walk can feed, beside the route's own partial flag.
    """
    return _walk_budget().partial_fields()


def _window_days(params: dict, default: int) -> int:
    """The `days` query parameter, validated (0-9999, 0 = all time) and resolved
    against the earliest-data watermark to the concrete number of days to read.
    See `shared.api.effective_window_days`.
    """
    return resolve_window_days(validate_days(params.get('days'), default=default), aggregates_table)


def _index_read_was_truncated(response: Mapping[str, Any]) -> bool:
    """True when a single unpaged query left rows behind.

    `/metrics/sources`, `/metrics/personas` and `/feedback/entities` read the
    `gsi1-by-metric-type` index with ONE query and no cursor, so DynamoDB's 1 MB
    page limit is the real bound on how many aggregate rows they see. That is the
    same class of fact as the paging bound in `_query_metric_window` — rows exist
    that were not counted — and it was being discarded in the same way.

    REPORTED, not followed: paging these reads would change which data the answer
    is computed from, and this change is about saying whether the window is
    complete, not about widening it.
    """
    return bool(response.get('LastEvaluatedKey'))


def _persona_bucket(item: dict) -> str:
    """The persona bucket one RAW FEEDBACK item belongs to, on the scan path.

    A one-line delegation to `shared.feedback.persona_bucket`, kept as a named
    function here only so that the reason the scan path needs one at all lives beside
    the two branches that call it.

    The scan path exists because aggregates are bucketed by import date only, so a
    review-date window or a source filter has to be computed from raw items — and
    that makes this the read side's answer to the same question
    `aggregator/handler.py::counter_dimensions` answers when it names a
    `METRIC#persona#<value>` row. The two must agree, or `/metrics/personas`
    reports one thing for `?date_basis=review` and another for the default basis
    over the same items. One window, two code paths, two different answers is the
    defect class this file has now been repaired for twice.

    🔑 IT IS ONE FUNCTION IN `shared/`, NOT TWO EXPRESSIONS THAT AGREE. An earlier
    round of this change duplicated the expression and pinned the two copies to each
    other, on the reasoning that a constant two Lambdas must SPELL alike is a fact to
    share while an expression they must COMPUTE alike is a behaviour to pin. What
    ended that was the derivation growing a branch: it now buckets a value outside
    PERSONA_ARCHETYPES as the empty value, so the axis is CLOSED — and "closed" is a
    property of the derivation, which two copies could widen independently. See
    `persona_bucket`.

    Why the field is the archetype and not the name is argued where the constant is
    declared. The short of it: `persona_name` is legitimately null for anonymous
    feedback, which is most of this corpus, so bucketing by it put 99.97% of a
    6,239-item corpus in one bucket.
    """
    return persona_bucket(item)


# ============================================
# Shared pieces of the read routes
# ============================================


class _ItemFilters:
    """The post-query filters `/feedback/urgent` and `/feedback/search` share.

    Both read the same four query parameters, both derive the same days-long window
    ending today (the one `/feedback` and `/metrics/*` use), and both drop an item
    the same way: outside the window on the selected basis, or not matching a given
    source / sentiment / category. One definition, so the two routes cannot drift.
    """

    def __init__(
        self, params: dict, days: int, scope: CategoryScope = category_access.UNRESTRICTED,
    ):
        self.scope = scope
        self.date_basis = validate_date_basis(params.get('date_basis'))
        self.source = params.get('source')
        self.sentiment = params.get('sentiment')
        self.category = params.get('category')
        # Issue-tracker filters (github_issues items only; see shared/github_metrics.py).
        self.version = params.get('version')
        self.label = params.get('label')
        # channel / dims / tag (shared/item_filters.py).
        self.extra = _extra_filters(params)
        self.cutoff_date = window_cutoff(days)

    def admits(self, item: dict) -> bool:
        if basis_date(item, self.date_basis) < self.cutoff_date:
            return False
        if not category_access.admits_item(self.scope, item):
            return False
        if self.source and item.get('source_platform') != self.source:
            return False
        if self.sentiment and item.get('sentiment_label') != self.sentiment:
            return False
        if not matches_issue_filters(item, self.version, self.label):
            return False
        if not self.extra.admits(item):
            return False
        return not (self.category and item.get('category') != self.category)


def _extra_filters(params: Mapping[str, Any] | None) -> ItemFilters:
    """The request's ``channel`` / ``dims`` / ``tag`` filters; 400 on a malformed ``dims``."""
    try:
        return parse_item_filters(params)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _ranked(counts: dict) -> dict:
    """`counts` as a dict ordered by descending value — the shape every breakdown returns."""
    return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True))


def _tally(items: list, field: str, default: str) -> dict[str, int]:
    """How many items carry each value of `field` (`default` when absent)."""
    counts: dict[str, int] = {}
    for item in items:
        value = item.get(field, default)
        counts[value] = counts.get(value, 0) + 1
    return counts


def _tally_personas(items: list) -> dict[str, int]:
    """One bucket per item, empty archetype included — see `_persona_bucket`."""
    counts: dict[str, int] = {}
    for item in items:
        persona = _persona_bucket(item)
        counts[persona] = counts.get(persona, 0) + 1
    return counts


def _issue_counts(items: list) -> dict[str, int]:
    """Occurrences of each problem summary, keyed by its first 100 characters."""
    issues: dict[str, int] = {}
    for item in items:
        problem = item.get('problem_summary', '')
        if problem and len(problem) > 5:
            problem_key = problem[:100].lower().strip()
            issues[problem_key] = issues.get(problem_key, 0) + 1
    return issues


def _entities_payload(category_counts: dict, issues: dict, persona_counts: dict, source_counts: dict) -> dict:
    """The `entities` map of `/feedback/entities`, every breakdown ranked, issues capped at 20."""
    return {
        'keywords': {},
        'categories': _ranked(category_counts),
        'issues': dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20]),
        'personas': _ranked(persona_counts),
        'sources': _ranked(source_counts),
    }


# ============================================
# Channels, tags and dimensions: the classification breakdowns
# ============================================

# `/feedback/entities` lists at most this many tags (the most frequent).
MAX_ENTITY_TAGS = 50
SENTIMENT_LABELS = ('positive', 'neutral', 'negative', 'mixed')
# The aggregator's row prefixes (aggregator/handler.py; the Lambdas cannot import each other).
CHANNEL_PREFIX = 'METRIC#daily_channel#'
TAG_PREFIX = 'METRIC#daily_tag#'
DIMENSION_SENTIMENT_PREFIX = 'METRIC#daily_dim_sentiment#'
DIMENSION_SENTIMENT_METRIC_TYPE = 'dim_sentiment#'


def _dimensions_config() -> list[dict[str, Any]]:
    """The configured dimensions, read once per request; [] when none or unreadable (a read path)."""
    cached = app.context.get('dimensions_config')
    if isinstance(cached, list):
        return cached
    try:
        config = load_dimensions_config(_aggregates_table())
    except (ClientError, BotoCoreError, ValueError) as exc:
        logger.warning('Dimensions config unreadable; answering without dimensions',
                       extra={'error_type': type(exc).__name__})
        config = []
    app.append_context(dimensions_config=config)
    return config


def _top_tags(counts: Mapping[str, int]) -> dict[str, int]:
    return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True)[:MAX_ENTITY_TAGS])


def _item_tags(item: Mapping[str, Any]) -> set[str]:
    tags = item.get('tags')
    return {t.strip().lower() for t in tags if isinstance(t, str) and t.strip()} if isinstance(tags, list) else set()


def _item_dimension(item: Mapping[str, Any], key: str) -> str | None:
    dimensions = item.get('dimensions')
    value = dimensions.get(key) if isinstance(dimensions, Mapping) else None
    return value if isinstance(value, str) else None


def _classification_from_items(items: list, config: list[dict[str, Any]]) -> dict[str, Any]:
    """``channels``, ``tags`` (top 50, lower-cased) and ``dimensions`` counted over raw items."""
    tags: dict[str, int] = {}
    for item in items:
        for tag in _item_tags(item):
            tags[tag] = tags.get(tag, 0) + 1
    dimensions: dict[str, dict[str, int]] = {}
    for dimension in config:
        counts: dict[str, int] = {}
        for item in items:
            value = _item_dimension(item, dimension['key'])
            if value is not None:
                counts[value] = counts.get(value, 0) + 1
        dimensions[dimension['key']] = _ranked(counts)
    channels = _tally([i for i in items if i.get('source_channel')], 'source_channel', 'unknown')
    return {'channels': _ranked(channels), 'tags': _top_tags(tags), 'dimensions': dimensions}


def _dimension_sentiment_totals(key: str, days: int, current_date: datetime) -> tuple[dict[str, dict[str, int]], bool]:
    """``{value: {label: n}}`` for one dimension from its `dim_sentiment#<key>` aggregate rows."""
    totals, is_partial = _metric_type_totals(
        f'{DIMENSION_SENTIMENT_METRIC_TYPE}{key}', f'{DIMENSION_SENTIMENT_PREFIX}{key}#', days, current_date)
    by_value: dict[str, dict[str, int]] = {}
    for value_label, count in totals.items():
        value, _, label = value_label.rpartition('#')
        if value:
            labels = by_value.setdefault(value, {})
            labels[label] = labels.get(label, 0) + count
    return by_value, is_partial


def _classification_from_aggregates(
    config: list[dict[str, Any]], days: int, current_date: datetime,
) -> tuple[dict[str, Any], bool]:
    """The same three breakdowns from the aggregator's rows (the unfiltered, unrestricted path)."""
    (channels, channels_partial), (tags, tags_partial) = concurrently(
        lambda: _metric_type_totals('channel', CHANNEL_PREFIX, days, current_date),
        lambda: _metric_type_totals('tag', TAG_PREFIX, days, current_date),
    )
    keys = [dimension['key'] for dimension in config]
    per_key = ordered_map(lambda key: _dimension_sentiment_totals(key, days, current_date), keys)
    dimensions = {
        key: _ranked({value: sum(labels.values()) for value, labels in by_value.items()})
        for key, (by_value, _) in zip(keys, per_key, strict=True)
    }
    is_partial = channels_partial or tags_partial or any(partial for _, partial in per_key)
    return {'channels': _ranked(channels), 'tags': _top_tags(tags), 'dimensions': dimensions}, is_partial


def _metric_window_pair(pk: str, days: int, current_date: datetime) -> tuple[list[dict], bool]:
    """One `_query_metric_window` read, as the `(items, truncated)` pair."""
    items, truncated = _query_metric_window(pk, days, current_date)
    return items, truncated


def _metric_windows(pks: list[str], days: int, current_date: datetime) -> list[tuple[list[dict], bool]]:
    """`_query_metric_window` for each pk, CONCURRENTLY, as pairs in `pks` order.

    The partitions are independent reads, so the request waits for the slowest
    one rather than their sum; every caller still ORs each pair's flag.
    """
    return ordered_map(lambda pk: _metric_window_pair(pk, days, current_date), pks)


def _metric_window_totals(
    pk_prefix: str, names: list[str], days: int, current_date: datetime,
) -> tuple[dict[str, int], bool]:
    """Sum one `METRIC#...#<name>` partition per name over the window.

    One partition per name, and a short read of ANY of them leaves the breakdown
    understated, so truncation ORs across names rather than being attributed to
    one. Aggregate rows are never deleted, so any window is answerable in full.
    Returns the per-name totals (zeros included) and that flag.
    """
    windows = _metric_windows([f'{pk_prefix}{name}' for name in names], days, current_date)
    is_partial = False
    totals: dict[str, int] = {}
    for name, (window, truncated) in zip(names, windows, strict=True):
        is_partial = is_partial or truncated
        totals[name] = sum(int(item.get('count', 0)) for item in window)
    return totals, is_partial


def _metric_type_totals(
    metric_type: str, pk_prefix: str, days: int, current_date: datetime,
) -> tuple[dict[str, int], bool]:
    """Per-value totals over the window from the `gsi1-by-metric-type` index.

    `/metrics/sources`, `/metrics/personas` and `/feedback/entities` read their
    aggregates this way: one unpaged query of every row of `metric_type`, kept to
    the window by date, with the value read off the partition key after
    `pk_prefix`. Partial when the single read left rows behind.
    """
    response = _aggregates_table().query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq(metric_type)
    )
    is_partial = _index_read_was_truncated(response)

    totals: dict[str, int] = {}
    oldest = (current_date - timedelta(days=days - 1)).strftime('%Y-%m-%d')
    newest = current_date.strftime('%Y-%m-%d')

    items: list[dict[str, Any]] = response.get('Items', [])
    for item in items:
        sk = item.get('sk')
        if isinstance(sk, str) and oldest <= sk <= newest:
            value = item['pk'].replace(pk_prefix, '')
            totals[value] = totals.get(value, 0) + int(item.get('count', 0))
    return totals, is_partial


def _metrics_window() -> tuple[dict, int, str]:
    """The query string and the `days` window and date basis every `/metrics/*` route reads."""
    params = app.current_event.query_string_parameters or {}
    days = _window_days(params, default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    return params, days, date_basis


def _feedback_by_id(feedback_id: str) -> dict:
    """The one item with this `feedback_id`, or a 404.

    Also a 404 when the item's category is outside the caller's scope — the same
    answer as a missing item, so restricted callers learn nothing about it.
    """
    response = _feedback_table().query(
        IndexName=FEEDBACK_BY_ID_INDEX,
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    items = response.get('Items', [])
    if not items or not category_access.admits_item(_caller_scope(), items[0]):
        raise NotFoundError(f"Feedback {feedback_id} not found")
    return items[0]


# ============================================
# Feedback Endpoints
# ============================================


@app.get("/feedback")
@tracer.capture_method
def list_feedback():
    """
    List feedback with optional filters and offset/limit pagination.

    Pagination semantics: results are paginated within a date-window candidate
    set (or category-window when only ``category`` is supplied). The returned
    ``total`` reflects the size of the filtered candidate window, not the full
    dataset, and the candidate window is bounded by ``MAX_FEEDBACK_OFFSET``.

    The ``days`` window applies in both branches: the date-window branch
    queries only in-window import dates, and the category branch post-filters
    its (time-unbounded) GSI results down to the window.

    The ``is_partial_window`` flag is true when the candidate window was
    truncated by the cap; in that case more matching records may exist beyond
    the window and ``total`` is a lower bound on the true count.

    ``date_basis`` selects which date the ``days`` window applies to:
    'imported' (default, when the item entered the data lake) or 'review'
    (when the customer wrote it, via ``source_created_at``).
    """
    params = app.current_event.query_string_parameters or {}

    days = _window_days(params, default=7)
    date_basis = validate_date_basis(params.get('date_basis'))
    source = params.get('source')
    category = params.get('category')
    sentiment = params.get('sentiment')
    version = params.get('version')
    label = params.get('label')
    extra = _extra_filters(params)
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    offset = validate_int(
        params.get('offset'),
        default=0,
        min_val=0,
        max_val=MAX_FEEDBACK_OFFSET,
    )

    # Sizing the candidate window:
    #
    # - Without post-query filters, a small overshoot beyond offset+limit is
    #   enough to paginate, and `total` is an intentionally windowed lower bound.
    # - With post-query filters (source/sentiment/category), stopping at that
    #   small overshoot would undercount the filtered `total` and spuriously set
    #   `is_partial_window` (e.g. "2 of 2+"): the candidates that survive the
    #   filter are a small subset of the scanned window. In that case we scan the
    #   full window (up to MAX_FEEDBACK_OFFSET) so the filtered count is exact and
    #   `is_partial_window` only trips on genuine cap truncation.
    scope = _caller_scope()
    has_post_filter = (
        bool(source) or bool(sentiment) or bool(category)
        or bool(version) or bool(label)
        or extra.active
        or date_basis == DATE_BASIS_REVIEW
        or not scope.all
    )
    candidate_cap = (
        MAX_FEEDBACK_OFFSET if has_post_filter
        else max((offset + limit) * 2, MIN_CANDIDATE_CAP)
    )

    candidates: list[dict[str, Any]] = []
    window_truncated = False

    if category and not source:
        # Category is the partition key here, so no source push-down needed;
        # paging still matters because one query returns at most one page.
        candidates, window_truncated = _query_partition(
            FEEDBACK_BY_CATEGORY_INDEX,
            Key('gsi2pk').eq(f'CATEGORY#{category}'),
            max_matched=candidate_cap,
        )
    else:
        budget = _walk_budget()
        for i, date in enumerate(budgeted_days(days, budget)):
            # Push the source filter down to DynamoDB and page the partition:
            # a day dominated by another source would otherwise fill the whole
            # page and starve the in-memory filter (issue #99).
            day_items, day_has_more = _query_partition(
                FEEDBACK_BY_DATE_INDEX,
                Key('gsi1pk').eq(f'DATE#{date}'),
                max_matched=candidate_cap - len(candidates),
                source=source,
            )
            candidates.extend(day_items)
            if len(candidates) >= candidate_cap:
                # We hit the cap before exhausting the date range.
                window_truncated = day_has_more or i < days - 1
                break
        window_truncated = window_truncated or budget.stopped

    if date_basis == DATE_BASIS_REVIEW or (category and not source):
        # The `days` window applies to the selected basis date. The date-loop
        # branch already bounds imported-basis candidates by construction, but
        # the category-GSI branch is time-unbounded (sorted by sentiment), so
        # the cutoff enforces `days` there too, using this handler's window
        # definition (_window_cutoff, a days-long window ending today).
        # Review basis always needs the post-filter because GSI windows are
        # keyed on import date, and a review can never be imported before it
        # was written.
        cutoff = window_cutoff(days)
        candidates = [c for c in candidates if basis_date(c, date_basis) >= cutoff]
    if source:
        candidates = [i for i in candidates if i.get('source_platform') == source]
    if category and source:
        candidates = [i for i in candidates if i.get('category') == category]
    if sentiment:
        candidates = [i for i in candidates if i.get('sentiment_label') == sentiment]
    if version or label:
        candidates = [i for i in candidates if matches_issue_filters(i, version, label)]
    candidates = extra.filter(candidates)
    candidates = category_access.filter_items(scope, candidates)

    total = len(candidates)
    page = candidates[offset:offset + limit]

    return {
        'count': len(page),
        'total': total,
        'offset': offset,
        'limit': limit,
        'is_partial_window': window_truncated,
        **_walk_partial_fields(),
        'items': page,
    }


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items with optional filters.

    One bounded, paged read of the urgency partition (`_query_partition`), then
    ONE BatchGetItem per 100 candidates for the full items — not a `get_item` per
    row, and not a single page (issue #267 item 2).

    The key condition bounds the read to the window server-side: `gsi3sk` is the
    processing timestamp, written in the same instant as `date` (the import-date
    basis), and a review date is never later than its import date, so no row
    older than the cutoff can be admitted on either basis.

    The response shape is unchanged (`{count, items}`): a short read — rows left
    unread by the scan bound or over-fetch cap, or keys a batch kept unprocessed —
    is logged, not published, because a new field is also a change to what the
    global MCP's urgent-feedback tool returns to external clients.
    """
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    days = _window_days(params, default=30)
    filters = _ItemFilters(params, days, _caller_scope())

    # `source` is pushed down as a FilterExpression (`source_platform` is
    # projected into the index), so it does not need the over-fetch.
    has_post_filters = bool(
        filters.sentiment or filters.category or filters.version or filters.label
        or filters.extra.active
        or filters.date_basis == DATE_BASIS_REVIEW
        or not filters.scope.all
    )
    candidates, has_more = _query_partition(
        FEEDBACK_BY_URGENCY_INDEX,
        Key('gsi3pk').eq('URGENCY#high') & Key('gsi3sk').gte(filters.cutoff_date),
        max_matched=limit * URGENT_FILTERED_OVERFETCH if has_post_filters else limit,
        source=filters.source,
    )
    full_items, unread = _batch_get_feedback(candidates)
    items = [item for item in full_items if filters.admits(item)][:limit]
    if len(items) < limit and (has_more or unread):
        logger.info('Urgent feedback page is short of limit with rows unread',
                    extra={'limit': limit, 'returned': len(items), 'unprocessed_keys': unread})

    # NOTE: `count` is this page's length, NOT the number of urgent items in the
    # window — the read above stops once enough candidates are collected, so
    # `count` is bounded by `limit`. Do not read it as a total: the sidebar urgent
    # badge did exactly that with limit=10 and could never display more than 10.
    # For a true total use /metrics/summary's `urgent_count`, which sums the
    # exact METRIC#urgent daily aggregates. Renaming this field (or adding a
    # companion `total`/`has_more`) is an API change left to its own commit;
    # `test_count_is_the_returned_page_length_not_the_window_total` pins the
    # current semantics so the constraint is discoverable.
    return {'count': len(items), 'items': items}


def _feedback_keys(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The base-table keys of `rows`, de-duplicated, in row order; keyless rows dropped."""
    keys = {(row.get('pk'), row.get('sk')): None for row in rows if row.get('pk') and row.get('sk')}
    return [{'pk': pk, 'sk': sk} for pk, sk in keys]


@tracer.capture_method
def _batch_get_feedback(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """The full feedback items for GSI `rows`, in row order, via BatchGetItem.

    Returns ``(items, unread)``: ``unread`` is True when a chunk still had
    UnprocessedKeys after `BATCH_GET_ATTEMPTS` (those items are skipped, never
    an error — the route degrades to a shorter page and says so). A key whose
    item no longer exists is simply absent, as `get_item` returning no `Item` was.

    Issued on the resource's client, which takes and returns native Python values.
    """
    table = _feedback_table()
    keys = _feedback_keys(rows)
    by_key: dict[tuple[Any, Any], dict[str, Any]] = {}
    unread = False
    for start in range(0, len(keys), BATCH_GET_MAX_KEYS):
        pending: Mapping[str, Any] = {table.name: {'Keys': keys[start:start + BATCH_GET_MAX_KEYS]}}
        for attempt in range(BATCH_GET_ATTEMPTS):
            if attempt:
                time.sleep(BATCH_GET_BACKOFF_SECONDS * 2 ** attempt)
            response = table.meta.client.batch_get_item(RequestItems=pending)
            for item in response.get('Responses', {}).get(table.name, []):
                by_key[(item.get('pk'), item.get('sk'))] = item
            pending = response.get('UnprocessedKeys') or {}
            if not pending:
                break
        if pending:
            logger.warning('BatchGetItem left feedback keys unprocessed', extra={'attempts': BATCH_GET_ATTEMPTS})
            unread = True
    ordered = [by_key.get((key['pk'], key['sk'])) for key in keys]
    return [item for item in ordered if item is not None], unread


@app.get("/feedback/entities")
@tracer.capture_method
def get_entities():
    """Get entity extraction for chat filters."""
    params = app.current_event.query_string_parameters or {}
    days = _window_days(params, default=7)
    limit = validate_limit(params.get('limit'), default=100, max_val=200)
    source = params.get('source')
    date_basis = validate_date_basis(params.get('date_basis'))

    current_date = datetime.now(UTC)

    scope = _caller_scope()
    extra = _extra_filters(params)
    config = _dimensions_config()
    # Aggregates are bucketed by import date only, so both the source filter
    # and the review-date basis require computing entities from raw items. So
    # does a category-restricted caller (the source/persona/total aggregates
    # count every category) and a channel / dims / tag filter.
    if source or extra.active or date_basis == DATE_BASIS_REVIEW or not scope.all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)

        category_counts = _tally(items, 'category', 'other')
        source_counts = _tally(items, 'source_platform', 'unknown')
        # Counted for EVERY item, including the ones with no archetype, because
        # the aggregates branch below counts every item too — the aggregator
        # writes exactly one persona counter per item. Skipping the empty ones
        # here would make the two branches of one route disagree about the same
        # window, which is what `_persona_bucket` exists to prevent.
        persona_counts = _tally_personas(items)
        issues = _issue_counts(items)

        return {
            'period_days': days,
            'feedback_count': len(items),
            'is_partial': is_partial,
            **_walk_partial_fields(),
            # Always False on this branch, and published rather than omitted for the
            # reason `is_partial` is: a reader cannot tell an absent flag from a false
            # one. It cannot be true here because this branch DERIVES every bucket
            # through `persona_bucket`, which only ever emits a member of the enum —
            # so the flag also documents the difference between the two branches.
            'has_legacy_persona_buckets': False,
            'entities': {
                **_entities_payload(category_counts, issues, persona_counts, source_counts),
                **_classification_from_items(items, config),
            },
        }

    # The aggregates path. `is_partial` is computed here, exactly as the scan
    # path above computes it, rather than left to the `False` this response used
    # to omit its way into: a reader cannot tell an absent flag from a false one.
    # Four independent aggregate reads, run concurrently (results in this order).
    # PERSONA_PREFIX, shared with the aggregator that BUILT this pk: two Lambdas
    # that cannot import each other must strip exactly what the other prepended,
    # or the bucket names come back mangled.
    configured = get_configured_categories(aggregates_table)
    (category_totals, is_partial), (source_totals, sources_partial), (persona_counts, personas_partial), \
        (total_window, total_truncated) = concurrently(
            lambda: _metric_window_totals('METRIC#daily_category#', configured, days, current_date),
            lambda: _metric_type_totals('source', 'METRIC#daily_source#', days, current_date),
            lambda: _metric_type_totals('persona', PERSONA_PREFIX, days, current_date),
            lambda: _metric_window_pair('METRIC#daily_total', days, current_date),
        )
    category_counts = {category: total for category, total in category_totals.items() if total > 0}
    is_partial = is_partial or sources_partial or personas_partial or total_truncated
    feedback_count = sum(int(item.get('count', 0)) for item in total_window)
    classification, classification_partial = _classification_from_aggregates(config, days, current_date)
    is_partial = is_partial or classification_partial

    # Extract issues from recent feedback
    feedback_items = []
    for i in range(min(days, 7)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = _feedback_table().query(
            IndexName=FEEDBACK_BY_DATE_INDEX,
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=50,
            ScanIndexForward=False
        )
        feedback_items.extend(response.get('Items', []))
        if len(feedback_items) >= limit:
            break

    issues = _issue_counts(feedback_items[:limit])

    # `is_partial` describes the COUNTS (categories, sources, personas,
    # feedback_count), which is what the scan branch's flag describes too. The
    # `issues` map is a deliberate sample on both branches — the newest rows of
    # at most seven days, capped at `limit` — and is not what this flag is about;
    # folding that in would make it true on nearly every call and so mean nothing.
    return {
        'period_days': days,
        'feedback_count': feedback_count,
        'is_partial': is_partial,
        # Rows written before the persona axis moved come back exactly as stored, so
        # this window can carry free-text names and a capitalised `Unknown` beside the
        # enum's values. Reported, never repaired — see `has_legacy_persona_buckets`.
        'has_legacy_persona_buckets': has_legacy_persona_buckets(persona_counts),
        'entities': {
            **_entities_payload(category_counts, issues, persona_counts, source_totals),
            **classification,
        },
    }


@app.get("/feedback/search")
@tracer.capture_method
def search_feedback():
    """Search feedback by text query with optional filters."""
    params = app.current_event.query_string_parameters or {}

    query = params.get('q', '').strip().lower()
    # No search term at all is not an error: `q` absent or blank means the caller
    # is not searching, and the filter-only answer belongs to `/feedback` (which
    # is where MCP's adapter routes such a call). An empty result is the honest
    # answer to an empty question.
    if not query:
        return {'count': 0, 'items': [], 'entities': {}, 'query': query}
    # A term that IS present but too short used to return the same empty success,
    # which is a very different claim: it reports "nothing in the corpus matches"
    # about a search that was never run. On the dashboard a human sees their own
    # one-character box and infers it; through MCP a model receives
    # `{'count': 0}` with no error and reports "no customer mentioned that".
    if len(query) < SEARCH_QUERY_MIN_LENGTH:
        raise ValidationError(
            f"Search query must be at least {SEARCH_QUERY_MIN_LENGTH} characters "
            f"after trimming; received {len(query)}."
        )

    days = _window_days(params, default=30)
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    filters = _ItemFilters(params, days, _caller_scope())

    # The REQUESTED window, not a second undocumented one.
    #
    # This read `min(days, 30)` while `cutoff_date` above was computed from the
    # caller's full `days`, so the two disagreed: at `days=365` the filter admitted
    # a year of items and the candidate set held thirty days of them. Every item
    # older than a month was unreachable by text search at ANY `days` value, and
    # the answer was a plain `count: 0` — a claim about the corpus standing in for
    # the boundary of a scan. On the corpus this was found on, a 5,240-item import
    # sits 37 days back, so roughly 84% of it could not be searched.
    #
    # `is_partial` is now KEPT rather than discarded (`candidates, _ =`). That is
    # the load-bearing half: the soft cap still bounds how many candidates are
    # collected, so widening the window without saying when the scan stopped early
    # would only make an incomplete answer slower and no more honest.
    candidates, window_truncated = _scan_recent_items(
        days, per_day_limit=300, soft_cap=CANDIDATES_SOFT_CAP,
        source=filters.source,
    )

    items = []
    for item in candidates:
        if not filters.admits(item):
            continue

        original_text = (item.get('original_text') or '').lower()
        title = (item.get('title') or '').lower()
        problem_summary = (item.get('problem_summary') or '').lower()

        if query in original_text or query in title or query in problem_summary:
            items.append(item)
            if len(items) >= limit:
                break

    return {
        'count': len(items),
        'items': items,
        'entities': {
            'categories': _ranked(_tally(items, 'category', 'other')),
            'sources': _ranked(_tally(items, 'source_platform', 'unknown')),
            'sentiments': _ranked(_tally(items, 'sentiment_label', 'neutral')),
        },
        'query': query,
        # Named as `/feedback` names it, because it means the same thing and a
        # second name for one concept is how the two drift. True when the
        # candidate scan stopped on the soft cap, so `count: 0` can be told apart
        # from "the scan gave up before it reached the end of the window" — which
        # is the distinction the caller could not previously make at all.
        #
        # Hitting `limit` is deliberately NOT truncation here, matching
        # `/feedback`: a caller that asked for N and received N can see that for
        # itself, whereas a scan that stopped early is invisible without this.
        'is_partial_window': window_truncated,
        **_walk_partial_fields(),
    }


@app.get("/feedback/access")
@tracer.capture_method
def get_feedback_access():
    """The caller's category scope: `{all, categories}` (any signed-in user).

    Registered before `/feedback/<feedback_id>`; Powertools also matches static
    routes first, so `access` is never read as a feedback id.
    """
    return _caller_scope().to_dict()


@app.get("/feedback/<feedback_id>")
@tracer.capture_method
def get_feedback(feedback_id: str):
    """Get a single feedback item by ID."""
    return _feedback_by_id(feedback_id)


@app.get("/feedback/<feedback_id>/similar")
@tracer.capture_method
def get_similar_feedback(feedback_id: str):
    """Get feedback items similar to the given one."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=8, max_val=50)

    category = _feedback_by_id(feedback_id).get('category', 'other')

    response = _feedback_table().query(
        IndexName=FEEDBACK_BY_CATEGORY_INDEX,
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=limit + 10,
        ScanIndexForward=False
    )

    # Filter the RESULTS too: the partition is keyed on gsi2pk, which is not
    # guaranteed to agree with each item's `category`, so admitting the source
    # item does not admit its neighbours.
    candidates = [item for item in response.get('Items', []) if item.get('feedback_id') != feedback_id]
    similar_items = category_access.filter_items(_caller_scope(), candidates)[:limit]

    return {
        'source_feedback_id': feedback_id,
        'count': len(similar_items),
        'items': similar_items
    }


# ============================================
# Metrics Endpoints
# ============================================

def _summary_from_items(
    days: int,
    date_basis: str = DATE_BASIS_REVIEW,
    scope: CategoryScope = category_access.UNRESTRICTED,
    extra: ItemFilters | None = None,
    source: str | None = None,
) -> tuple[list[dict], list[dict], int, bool]:
    """Summary inputs bucketed by review date from raw feedback.

    Returns `(daily_totals, daily_sentiment, urgent_count, is_partial)`, the same
    four things the aggregates branch of `get_summary` reads, so the route totals
    and publishes them once for both bases.

    Pre-computed aggregates are bucketed by import date only, so the
    review-date basis derives daily totals, sentiment averages, and urgent
    counts on the fly (same approach as the source-filtered metric branches).
    The scan budget matches /feedback's candidate cap so both endpoints
    describe the same window; `is_partial` is set when the scan truncated
    and the numbers are a lower bound.
    """
    items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)

    daily_counts: dict[str, int] = {}
    daily_sentiment: dict[str, dict[str, float]] = {}
    urgent_count = 0
    for item in items:
        day = basis_date(item, date_basis)
        daily_counts[day] = daily_counts.get(day, 0) + 1
        score = item.get('sentiment_score')
        if score is not None:
            bucket = daily_sentiment.setdefault(day, {'sum': 0.0, 'count': 0})
            bucket['sum'] += float(score)
            bucket['count'] += 1
        if item.get('urgency') == 'high':
            urgent_count += 1

    totals = [
        {'date': day, 'count': count}
        for day, count in sorted(daily_counts.items(), reverse=True)
    ]
    sentiment_data = [
        {
            'date': day,
            'avg_sentiment': round(bucket['sum'] / bucket['count'], 3),
            'count': int(bucket['count']),
        }
        for day, bucket in sorted(daily_sentiment.items(), reverse=True)
    ]

    # Every item lands in exactly one day of `totals`, so totalling them is `len(items)`.
    return totals, sentiment_data, urgent_count, is_partial


@dataclass(frozen=True)
class _MetricRequest:
    """One `/metrics/*` request: its window, the caller's scope and the item filters.

    ``from_items`` is True when the answer must be computed from raw items: the
    aggregates are bucketed by import date, count every category and source, and
    are not keyed by ``source`` / ``channel`` / ``dims`` / ``tag``.
    """
    days: int
    date_basis: str
    scope: CategoryScope
    source: str | None
    extra: ItemFilters

    @property
    def from_items(self) -> bool:
        return bool(self.source or self.extra.active or self.date_basis == DATE_BASIS_REVIEW or not self.scope.all)

    def window_items(self) -> tuple[list[dict[str, Any]], bool]:
        """The caller's visible, filtered items of the window (``_scoped_window_items``)."""
        return _scoped_window_items(self.days, self.date_basis, self.scope, source=self.source, extra=self.extra)


def _metric_request() -> _MetricRequest:
    params, days, date_basis = _metrics_window()
    return _MetricRequest(days, date_basis, _caller_scope(), params.get('source'), _extra_filters(params))


@app.get("/metrics/summary")
@tracer.capture_method
def get_summary():
    """Get dashboard summary metrics."""
    request = _metric_request()
    days = request.days
    if request.from_items:
        totals, sentiment_data, urgent_count, is_partial = _summary_from_items(
            days, request.date_basis, request.scope, extra=request.extra, source=request.source)
    else:
        totals, sentiment_data, urgent_count, is_partial = _summary_from_aggregates(days)

    total_feedback = sum(int(t['count']) for t in totals)
    avg_sentiment = sum(
        float(s['avg_sentiment']) * int(s['count']) for s in sentiment_data
    ) / max(total_feedback, 1)

    return {
        'period_days': days,
        'total_feedback': total_feedback,
        'avg_sentiment': round(avg_sentiment, 3),
        'urgent_count': urgent_count,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'daily_totals': totals,
        'daily_sentiment': sentiment_data,
    }


def _summary_from_aggregates(days: int) -> tuple[list[dict], list[dict], int, bool]:
    """Summary inputs from the pre-computed daily aggregates (the default basis)."""
    current_date = datetime.now(UTC)

    # Three partitions, one flag: a short read of ANY of them makes the summary
    # incomplete, so they OR rather than each reporting for themselves. The
    # review-basis branch already returns `is_partial` from its scan; this
    # branch used to omit the key entirely, which a caller reads as "complete".
    # The three are independent partitions, read concurrently.
    (total_items, is_partial), (sentiment_items, sentiment_truncated), (urgent_items, urgent_truncated) = (
        _metric_windows(['METRIC#daily_total', 'METRIC#daily_sentiment_avg', 'METRIC#urgent'], days, current_date))
    totals = [
        {'date': item['sk'], 'count': item.get('count', 0)}
        for item in total_items
    ]

    is_partial = is_partial or sentiment_truncated
    sentiment_data = []
    for item in sentiment_items:
        if item.get('count', 0) > 0:
            avg = float(item.get('sum', 0)) / float(item['count'])
            sentiment_data.append({'date': item['sk'], 'avg_sentiment': round(avg, 3), 'count': item['count']})

    is_partial = is_partial or urgent_truncated
    urgent_count = sum(item.get('count', 0) for item in urgent_items)

    return totals, sentiment_data, urgent_count, is_partial


@app.get("/metrics/sentiment")
@tracer.capture_method
def get_sentiment_metrics():
    """Get sentiment breakdown."""
    params, days, date_basis = _metrics_window()
    source = params.get('source')
    extra = _extra_filters(params)
    scope = _caller_scope()

    sentiments = ['positive', 'neutral', 'negative', 'mixed']

    if source or extra.active or date_basis == DATE_BASIS_REVIEW or not scope.all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)

        result = dict.fromkeys(sentiments, 0)
        for item in items:
            sentiment = item.get('sentiment_label', 'neutral')
            if sentiment in result:
                result[sentiment] += 1
    else:
        # One partition per label, and a short read of any one of them leaves the
        # breakdown (and therefore `total` and every percentage) understated, so
        # truncation ORs across labels rather than being attributed to one.
        result, is_partial = _metric_window_totals(
            'METRIC#daily_sentiment#', sentiments, days, datetime.now(UTC))

    total = sum(result.values())
    return {
        'period_days': days,
        'total': total,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'breakdown': result,
        'percentages': {k: round(v / max(total, 1) * 100, 1) for k, v in result.items()}
    }


@app.get("/metrics/categories")
@tracer.capture_method
def get_category_metrics():
    """Get category breakdown."""
    params, days, date_basis = _metrics_window()
    source = params.get('source')
    extra = _extra_filters(params)

    scope = _caller_scope()
    categories = get_configured_categories(aggregates_table)
    if not categories:
        categories = DEFAULT_CATEGORIES
    # Per-category partitions: a category-restricted caller simply never reads
    # the forbidden ones. A SOURCE restriction cannot be served that way (every
    # partition counts every source), so it takes the item path.
    categories = category_access.visible_categories(scope, categories)

    if source or extra.active or date_basis == DATE_BASIS_REVIEW or not scope.sources_all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)
        result = _tally(items, 'category', 'other')
    else:
        # The reviewer-flagged instance (finding M4): this branch once reported an
        # `is_partial = False` it never computed, so 99 of 6,239 items came back as
        # a complete answer. One partition per category, so truncation in ANY of
        # them makes the breakdown partial — which `_metric_window_totals` ORs.
        totals, is_partial = _metric_window_totals(
            'METRIC#daily_category#', categories, days, datetime.now(UTC))
        result = {category: total for category, total in totals.items() if total > 0}

    return {
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'categories': _ranked(result)
    }


@app.get("/metrics/sources")
@tracer.capture_method
def get_source_metrics():
    """Get source platform breakdown."""
    request = _metric_request()
    days = request.days
    if request.from_items:
        items, is_partial = request.window_items()
        source_totals = _tally(items, 'source_platform', 'unknown')
    else:
        source_totals, is_partial = _metric_type_totals(
            'source', 'METRIC#daily_source#', days, datetime.now(UTC))

    return {
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'sources': _ranked(source_totals)
    }


@app.get("/metrics/personas")
@tracer.capture_method
def get_persona_metrics():
    """Get persona breakdown."""
    request = _metric_request()
    days = request.days
    if request.from_items:
        # Compute from raw items (see `_MetricRequest.from_items`). Every
        # item, empty archetype included — see `_persona_bucket` and the note in
        # `/feedback/entities`: the aggregates branch below counts one persona row
        # per item, so a scan branch that dropped the empty ones would answer a
        # different question over the same window.
        items, is_partial = request.window_items()
        personas = _tally_personas(items)
        return {
            'period_days': days,
            'is_partial': is_partial,
            **_walk_partial_fields(),
            # Cannot be true on a derived branch — see the same field in
            # `/feedback/entities`, and published for the same reason.
            'has_legacy_persona_buckets': False,
            'personas': _ranked(personas)
        }

    # PERSONA_PREFIX, shared with the aggregator that BUILT this pk — see the same
    # read in `get_entities`.
    personas, is_partial = _metric_type_totals(
        'persona', PERSONA_PREFIX, days, datetime.now(UTC))

    return {
        'period_days': days,
        'is_partial': is_partial,
        # The stored rows, as stored — so this window can mix the enum's values with
        # buckets only the old derivation could write. See `has_legacy_persona_buckets`.
        'has_legacy_persona_buckets': has_legacy_persona_buckets(personas),
        'personas': _ranked(personas)
    }


def _value_breakdown(labels: Mapping[str, int]) -> dict[str, int]:
    """``{count, positive, negative, neutral, mixed}`` from per-label counts (other labels count as neutral)."""
    breakdown = {label: int(labels.get(label, 0)) for label in SENTIMENT_LABELS}
    breakdown['neutral'] += sum(int(n) for label, n in labels.items() if label not in SENTIMENT_LABELS)
    return {'count': sum(breakdown.values()), **breakdown}


def _dimension_from_items(key: str, items: list) -> tuple[dict[str, dict[str, int]], int]:
    """Per-value sentiment counts of one dimension over raw items, and how many items have no value."""
    by_value: dict[str, dict[str, int]] = {}
    unassigned = 0
    for item in items:
        value = _item_dimension(item, key)
        if value is None:
            unassigned += 1
            continue
        labels = by_value.setdefault(value, {})
        label = item.get('sentiment_label', 'neutral')
        labels[label] = labels.get(label, 0) + 1
    return by_value, unassigned


def _dimension_from_aggregates(key: str, days: int) -> tuple[dict[str, dict[str, int]], int, bool]:
    """The same from the aggregator's rows; unassigned = the window's total minus the assigned."""
    current_date = datetime.now(UTC)
    (by_value, partial), (total_window, total_truncated) = concurrently(
        lambda: _dimension_sentiment_totals(key, days, current_date),
        lambda: _metric_window_pair('METRIC#daily_total', days, current_date),
    )
    total = sum(int(item.get('count', 0)) for item in total_window)
    assigned = sum(sum(labels.values()) for labels in by_value.values())
    return by_value, max(total - assigned, 0), partial or total_truncated


@app.get("/metrics/dimensions")
@tracer.capture_method
def get_dimension_metrics():
    """Per-value counts and sentiment split of one configured dimension (``?key=``).

    The aggregates answer an unfiltered, unrestricted, import-date window; a
    ``source`` / ``channel`` / ``dims`` / ``tag`` filter, the review basis or a
    restricted caller is counted from the items instead. Every configured value is
    listed (zeros included), plus any stored value the config no longer has.
    """
    params, days, date_basis = _metrics_window()
    key = params.get('key')
    dimension = next((d for d in _dimensions_config() if d['key'] == key), None)
    if not isinstance(key, str) or dimension is None:
        raise ValidationError('key must name a configured dimension')
    source = params.get('source')
    extra = _extra_filters(params)
    scope = _caller_scope()

    if source or extra.active or date_basis == DATE_BASIS_REVIEW or not scope.all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)
        by_value, unassigned = _dimension_from_items(key, items)
    else:
        by_value, unassigned, is_partial = _dimension_from_aggregates(key, days)

    values = {name: _value_breakdown(by_value.get(name, {})) for name in allowed_values(dimension)}
    values.update({name: _value_breakdown(labels) for name, labels in by_value.items() if name not in values})
    return {
        'key': key,
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'values': values,
        'unassigned': unassigned,
    }


@app.get("/metrics/github")
@tracer.capture_method
def get_github_metrics():
    """GitHub Issues per release and per label: counts, weight (1 + 👍), sentiment,
    top complaints / error signatures per version, and what is new in the latest
    release. Optional ``repo`` narrows to one configured ``owner/name``.

    Computed from the raw items (``source_platform = github_issues`` pushed down
    to DynamoDB), after the caller's category filter — a restricted caller sees the
    in-scope subset, exactly as on ``/metrics/sources``.
    """
    params, days, date_basis = _metrics_window()
    repo = params.get('repo')
    items, is_partial = _scoped_window_items(
        days, date_basis, _caller_scope(), source=GITHUB_SOURCE, extra=_extra_filters(params))
    if repo:
        items = [i for i in items if issue_attributes(i).get('repo') == repo]
    return {
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        **github_breakdown(items),
    }


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    # One walk budget per request, started before routing; `resolve` clears it.
    app.append_context(walk_budget=WalkBudget())
    return app.resolve(event, context)
