"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

import os
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Attr, ConditionBase, Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import category_access, data_quality, other_category, release_watch
from shared import category_scope_query as scope_query
from shared.api import (
    DATE_BASIS_IMPORTED,
    DATE_BASIS_REVIEW,
    DEFAULT_CATEGORIES,
    SEARCH_QUERY_MIN_LENGTH,
    api_handler,
    create_api_resolver,
    effective_window_days,
    get_configured_categories,
    requested_window_cutoff,
    validate_date_basis,
    validate_days,
    validate_int,
    validate_limit,
)
from shared.aws import get_dynamodb_resource
from shared.category_access import CategoryScope
from shared.category_gate import scope_for_event
from shared.channel_index import CHANNEL_INDEX_FIELDS, ChannelIndexUnavailable, walk_channel
from shared.concurrency import concurrently, ordered_map
from shared.data_version import VersionRead
from shared.dimension_config import allowed_values, load_dimensions_config
from shared.exceptions import ConfigurationError, ValidationError
from shared.feedback import (
    PERSONA_PREFIX,
    basis_date,
    has_legacy_persona_buckets,
    persona_bucket,
    window_cutoff,
)
from shared.feedback_cursor import decode_key_cursor, decode_offset_cursor, encode_key_cursor, encode_offset_cursor
from shared.feedback_similarity import rank_similar
from shared.feedback_types import FEEDBACK_TYPE_KEY
from shared.github_metrics import GITHUB_SOURCE, github_breakdown, issue_attributes, matches_issue_filters
from shared.indexes import (
    AGGREGATES_BY_METRIC_TYPE_INDEX,
    FEEDBACK_BY_CATEGORY_INDEX,
    FEEDBACK_BY_DATE_INDEX,
    FEEDBACK_BY_ID_INDEX,
    FEEDBACK_BY_URGENCY_INDEX,
)
from shared.item_filters import NO_ITEM_FILTERS, ItemFilters, parse_item_filters
from shared.logging import logger, tracer
from shared.metric_keys import (
    CATEGORY_PREFIX,
    CHANNEL_PREFIX,
    DAILY_TOTAL_PK,
    DIMENSION_SENTIMENT_METRIC_TYPE,
    DIMENSION_SENTIMENT_PREFIX,
    SENTIMENT_AVG_PK,
    SENTIMENT_PREFIX,
    SOURCE_PREFIX,
    TAG_PREFIX,
    USEFULNESS_METRIC_TYPE,
    USEFULNESS_PREFIX,
)
from shared.problem_aggregation import PROBLEM_READ, SlimRead, aggregate_problems, parse_problem_query
from shared.response_cache import memoized_route, request_versions
from shared.time_budget import ROW_CAP_PARTIAL_REASON, WalkBudget, budgeted_days
from shared.urgent_pages import URGENCY_KEY_FIELDS, UrgentPage, read_urgent_page
from shared.usefulness import USEFULNESS_FIELD

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
# Projected reads lift it: the channel index (shared/channel_index.py) and the
# Problem Analysis read (shared/problem_aggregation.py) carry their own caps.
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

# The urgency index partition every urgent read (and its next_token) stays in.
URGENT_PARTITION = 'URGENCY#high'

# The fields `/feedback/search` matches `q` against (substring, case-insensitive).
SEARCH_TEXT_FIELDS = ('original_text', 'title', 'problem_summary')

# `/feedback/problems`' `type_counts` bucket of reviews with no `feedback_type` yet (stored before the backfill).
UNTYPED_COUNT_KEY = 'untyped'

# `/feedback/{id}/similar` ranks one Query page of this many category-partition rows.
SIMILAR_CANDIDATE_ROWS = 100

# What the day walks of the metric routes and the `/feedback` candidate window read
# off a review: the table keys (a list page is fetched in full by key), every field a
# metric or a list filter reads (`CHANNEL_INDEX_FIELDS`, the same contract the channel
# index serves those routes with) and the channel. A projected row is a tenth of a
# full review, and decoding thousands of full reviews was most of these routes' CPU.
# The caps and page size are the full-row walk's, so the walk reads exactly the same
# rows, pages and partial flags as before; only the attributes decoded shrink.
METRIC_ROW_FIELDS = ('pk', 'sk', *CHANNEL_INDEX_FIELDS, 'source_channel')
# `/feedback/entities`' issue sample reads only the problem summary.
ISSUE_SAMPLE_PROJECTION = {'ProjectionExpression': '#ps', 'ExpressionAttributeNames': {'#ps': 'problem_summary'}}

def _metric_row_read() -> SlimRead:
    """`METRIC_ROW_FIELDS` with the full-row walk's caps, read at call time like the walk reads them.

    The LIST routes' read (`/feedback`'s candidate window): they page full reviews by key, so
    their window stays at `MAX_FEEDBACK_OFFSET` rows.
    """
    return SlimRead(fields=METRIC_ROW_FIELDS, soft_cap=MAX_FEEDBACK_OFFSET,
                    max_scanned_per_partition=MAX_SCANNED_PER_PARTITION, page_limit=DATE_QUERY_LIMIT)


# Rows one AGGREGATE route (summary, categories, sentiment, sources, personas, dimensions,
# entities, github) holds per request and reads per day partition: the `/feedback/problems`
# capacity (`PROBLEM_READ`), so a 30,000-review import day counts in full. They only tally
# `METRIC_ROW_FIELDS`, a few hundred bytes a row; the walk budget still bounds the time.
AGGREGATE_READ_ROWS = PROBLEM_READ.soft_cap


def _aggregate_row_read() -> SlimRead:
    """`METRIC_ROW_FIELDS` at the aggregate capacity (`AGGREGATE_READ_ROWS`), read at call time."""
    return SlimRead(fields=METRIC_ROW_FIELDS, soft_cap=AGGREGATE_READ_ROWS,
                    max_scanned_per_partition=AGGREGATE_READ_ROWS, page_limit=PROBLEM_READ.page_limit)


# AWS Clients
# Its client decodes item lists in one fast pass (shared/aws.py → shared/dynamodb_fast_items.py):
# the read routes decode thousands of items per request.
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
    scope: CategoryScope | None = None,
    row_condition: ConditionBase | None = None,
    read: SlimRead | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Page one GSI partition via LastEvaluatedKey.

    ``read`` (a :class:`SlimRead`) projects each row to its fields and lifts the
    page size and the per-partition scan ceiling to what such rows afford.

    ``row_condition`` (e.g. ``other_category.other_condition``) is ANDed into the
    FilterExpression beside ``source`` and ``scope``.

    ``scope`` (a restricted caller's) is pushed down beside ``source``
    (``shared.category_scope_query``) so ``max_matched`` counts only rows the
    caller may see; callers still filter the result in memory.

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
    row_filter = scope_query.combine(
        Attr('source_platform').eq(source) if source else None, scope_query.scope_filter(scope), row_condition)
    max_scanned = read.max_scanned_per_partition if read else MAX_SCANNED_PER_PARTITION
    while True:
        kwargs: dict[str, Any] = {
            'IndexName': index_name,
            'KeyConditionExpression': key_expr,
            'Limit': read.page_limit if read else DATE_QUERY_LIMIT,
            'ScanIndexForward': False,
            **(read.query_kwargs() if read else {}),
        }
        if row_filter is not None:
            kwargs['FilterExpression'] = row_filter
        if last_key:
            kwargs['ExclusiveStartKey'] = last_key
        response = _feedback_table().query(**kwargs)
        matched.extend(response.get('Items', []))
        scanned += response.get('ScannedCount', len(response.get('Items', [])))
        last_key = response.get('LastEvaluatedKey')
        if not last_key:
            break
        if len(matched) >= max_matched or scanned >= max_scanned:
            has_more = True
            break
    # A last page can overshoot `max_matched`: the rows cut off here were not counted, so the
    # partition was NOT read in full (claiming it was made `scanned_through` name the cut day).
    return matched[:max_matched], has_more or len(matched) > max_matched


@tracer.capture_method
def _scan_recent_items(
    days: int,
    per_day_limit: int | None = None,
    soft_cap: int | None = None,
    source: str | None = None,
    row_condition: ConditionBase | None = None,
    scope: CategoryScope | None = None,
    read: SlimRead | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Collect items imported in the last `days` days via gsi1-by-date.

    ``read`` projects the rows (see :func:`_query_partition`) and, unless
    ``soft_cap`` is given, replaces the default cap with its own.

    Returns ``(items, is_partial)``. ``is_partial`` is True when the scan
    was truncated (a day partition had more matching rows than the budget
    allowed, or the soft cap ended the scan with days still unread) — i.e.
    the result is a sample, not the complete window.

    Each day partition is paged (see :func:`_query_partition`); ``source``
    is pushed down as a server-side filter so dominated partitions can't
    starve source-filtered results. ``per_day_limit`` bounds each day for
    sampling callers (search); by default a day may use the entire
    remaining budget. The default ``soft_cap`` (read at call time) matches ``/feedback``'s
    candidate cap so list totals and metric totals agree on the same window.

    The walk is also bounded by the request's wall-clock budget
    (:func:`_walk_budget`): when it runs out the scan stops, ``is_partial`` is
    True, and the route publishes ``partial_reason``/``scanned_through``.

    ``scope`` (a restricted caller's) is pushed into every day's query, so the
    soft cap counts only rows the caller may see. Without it a viewer of one
    category of a 17,000-review workspace was capped after 5,000 rows of every
    category (all-time summary 1,457 vs 4,277 in ``/metrics/categories``). A
    ``row_condition`` (``ItemFilters.row_condition``: the channel) is pushed down
    the same way, so a small channel is not crowded out of the cap by the rest.

    A non-sampling walk (no ``per_day_limit``) that still ends early on the cap, or
    on a day it could not read in full, records where it stopped on the walk
    budget with ``partial_reason: 'row_cap'`` (a wall-clock stop says ``'time_budget'``):
    ``scanned_through`` is the oldest day read in full, never the day the cap cut,
    and is omitted when the cap cut the first day walked.
    """
    budget = _walk_budget()
    if scope is not None and scope_query.admits_nothing(scope):
        return [], False
    if soft_cap is None:
        soft_cap = read.soft_cap if read else MAX_FEEDBACK_OFFSET
    items: list[dict[str, Any]] = []
    is_partial = False
    previous: str | None = None
    for i, date in enumerate(budgeted_days(days, budget)):
        remaining = soft_cap - len(items)
        day_items, day_has_more = _query_partition(
            FEEDBACK_BY_DATE_INDEX,
            Key('gsi1pk').eq(f'DATE#{date}'),
            max_matched=min(per_day_limit, remaining) if per_day_limit else remaining,
            source=source,
            scope=scope,
            row_condition=row_condition,
            read=read,
        )
        items.extend(day_items)
        is_partial = is_partial or day_has_more
        capped = len(items) >= soft_cap and i < days - 1
        if per_day_limit is None and (capped or day_has_more):
            # The oldest day read IN FULL: this one, unless the cap cut it part-way; then the
            # day walked just before it (None when the cut day is the first one walked).
            budget.record_stop(previous if day_has_more else date, ROW_CAP_PARTIAL_REASON)
        if len(items) >= soft_cap:
            is_partial = is_partial or capped
            break
        previous = date
    return items, is_partial or budget.stopped


def _scan_window_items(
    days: int, date_basis: str, source: str | None = None, scope: CategoryScope | None = None,
    extra: ItemFilters = NO_ITEM_FILTERS, slim: bool = False, read: SlimRead | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Collect items whose basis date falls within the last `days` days.

    Returns ``(items, is_partial)`` — see :func:`_scan_recent_items` (``scope``
    is pushed down there).

    For 'imported' this is the raw gsi1-by-date window. For 'review' the same
    window is post-filtered down to items actually written within it (see the
    containment note above).
    """
    channel_rows = _channel_rows(days, extra.channel, source, scope) if slim and extra.channel else None
    if channel_rows is not None:
        items, is_partial = channel_rows
    else:
        items, is_partial = _scan_recent_items(
            days, source=source, scope=scope, row_condition=extra.row_condition(), read=read)
    if date_basis == DATE_BASIS_REVIEW:
        cutoff = _basis_cutoff(days)
        items = [i for i in items if basis_date(i, date_basis) >= cutoff] if cutoff else items
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


def _channel_rows(
    days: int, channel: str, source: str | None, scope: CategoryScope | None,
) -> tuple[list[dict[str, Any]], bool] | None:
    """The window's rows of ``channel`` from ``gsi5-by-channel`` (slim: ``CHANNEL_INDEX_FIELDS``).

    ``source`` and the caller's scope are pushed down as on the day walk. ``None`` when the
    index does not exist yet (a deployment mid-upgrade): the caller falls back to the day walk.
    """
    if scope is not None and scope_query.admits_nothing(scope):
        return [], False
    row_filter = scope_query.combine(
        Attr('source_platform').eq(source) if source else None, scope_query.scope_filter(scope))
    try:
        return walk_channel(_feedback_table(), channel, window_cutoff(days), _walk_budget(), row_filter=row_filter)
    except ChannelIndexUnavailable:
        logger.warning('gsi5-by-channel unavailable; channel filter falls back to the day walk')
        return None


def _scoped_window_items(
    days: int, date_basis: str, scope: CategoryScope, source: str | None = None,
    extra: ItemFilters | None = None, slim: bool = True, read: SlimRead | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """:func:`_scan_window_items`, then the caller's category filter (and ``extra``).

    A filter STEP over the window scan: the scope is pushed into the scan's
    queries (so its soft cap counts visible rows only) and applied again here,
    so a restricted caller sees exactly the in-scope subset of the window.

    With a ``channel`` filter the rows come from ``gsi5-by-channel`` and carry only
    ``CHANNEL_INDEX_FIELDS``; a caller that reads anything else (review text) passes
    ``slim=False`` and keeps the day walk. The day walk of a slim caller reads the same
    fields (``_aggregate_row_read``: the aggregate routes' capacity) unless ``read`` names
    another projection.
    """
    if slim and read is None:
        read = _aggregate_row_read()
    items, is_partial = _scan_window_items(
        days, date_basis, source=source, scope=scope, extra=extra or NO_ITEM_FILTERS, slim=slim, read=read)
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
    """`{partial_reason: 'time_budget'|'row_cap', scanned_through?}` if a walk stopped early, else `{}`.

    Spread into every response a walk can feed, beside the route's own partial flag.
    """
    return _walk_budget().partial_fields()


def _versions() -> VersionRead:
    """This request's cache versions + the earliest-data watermark: ONE BatchGetItem,
    the round trip the lone watermark `get_item` used to cost (docs/caching.md)."""
    return request_versions(app, aggregates_table)


# Opt-in warm-container memo for the read routes below (shared/response_cache.py).
# The scope is resolved for every request before the memo is consulted.
_memoized = memoized_route(app, scope=_caller_scope, versions=_versions)


def _window_days(params: dict, default: int) -> int:
    """The `days` query parameter, validated (0-9999, 0 = all time) and resolved
    against the earliest-data watermark to the concrete number of days to read.
    See `shared.api.effective_window_days`.

    The REQUESTED days are kept on the request context: the clamped count is right
    for walking the import-date index, never for a basis-date cutoff
    (`_basis_cutoff`).
    """
    days = validate_days(params.get('days'), default=default)
    app.append_context(requested_days=days)
    return effective_window_days(days, _versions().earliest_date, datetime.now(UTC).date())


def _basis_cutoff(walk_days: int) -> str:
    """The oldest basis date (review or import) the request admits; '' = no cutoff (all time).

    From the days the caller ASKED for (`requested_window_cutoff`), not the walk's
    clamped count: clamping to "days since the earliest import" made the review-date
    cutoff the first import day, so every review written before it vanished (all
    time and 365 days collapsed to the import history; TODO Plan 0). On the import
    basis both cutoffs admit the same rows (nothing is imported before the history
    starts). A route that never resolved `days` through `_window_days` keeps the
    walk's own window.
    """
    requested = app.context.get('requested_days')
    if not isinstance(requested, int):
        return window_cutoff(walk_days)
    return requested_window_cutoff(requested, datetime.now(UTC).date())


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
        # `cutoff_date` bounds the index read (import timestamps, the clamped walk);
        # `basis_cutoff` is the requested window on the selected basis ('' = all time).
        self.cutoff_date = window_cutoff(days)
        self.basis_cutoff = _basis_cutoff(days)

    def admits(self, item: dict) -> bool:
        if self.basis_cutoff and basis_date(item, self.date_basis) < self.basis_cutoff:
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
        return not self.category or other_category.matches_category(item, self.category, self._configured())

    def _configured(self) -> list[str]:
        # Read only when a category filter needs it (cached per container in shared.api).
        return _configured_category_names()


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
@_memoized
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

    # `category=other` lists every review outside the configuration
    # (shared/other_category.py), which no single category partition holds, so it
    # walks the days with that condition pushed down instead.
    # A channel filter reads the channel's own key range (gsi5-by-channel, slim rows); the
    # page's full items are fetched below. None = the index is not there yet: walk as before.
    channel_rows = _channel_rows(days, extra.channel, source, scope) if extra.channel else None
    by_category_index = (
        channel_rows is None and bool(category) and not source and category != other_category.OTHER)
    if channel_rows is not None:
        candidates, window_truncated = channel_rows
    elif by_category_index:
        # Category is the partition key here, so no source push-down needed;
        # paging still matters because one query returns at most one page.
        candidates, window_truncated = _query_partition(
            FEEDBACK_BY_CATEGORY_INDEX,
            Key('gsi2pk').eq(f'CATEGORY#{category}'),
            max_matched=candidate_cap,
            row_condition=extra.row_condition(),
            read=_metric_row_read(),
        )
    else:
        other = (
            other_category.other_condition(_configured_category_names())
            if category == other_category.OTHER else None
        )
        row_condition = scope_query.combine(other, extra.row_condition())
        candidates, window_truncated = _walk_feedback_days(days, candidate_cap, source, row_condition)

    if date_basis == DATE_BASIS_REVIEW or by_category_index:
        # The `days` window applies to the selected basis date. The date-loop
        # branch already bounds imported-basis candidates by construction, but
        # the category-GSI branch is time-unbounded (sorted by sentiment), so
        # the cutoff enforces `days` there too, using this handler's window
        # definition (_window_cutoff, a days-long window ending today).
        # Review basis always needs the post-filter because GSI windows are
        # keyed on import date, and a review can never be imported before it
        # was written.
        # The cutoff is the REQUESTED window's (`_basis_cutoff`), none for all time.
        cutoff = _basis_cutoff(days)
        if cutoff:
            candidates = [c for c in candidates if basis_date(c, date_basis) >= cutoff]
    if source:
        candidates = [i for i in candidates if i.get('source_platform') == source]
    if category and not by_category_index:
        configured = _configured_category_names()
        candidates = [i for i in candidates if other_category.matches_category(i, category, configured)]
    if sentiment:
        candidates = [i for i in candidates if i.get('sentiment_label') == sentiment]
    if version or label:
        candidates = [i for i in candidates if matches_issue_filters(i, version, label)]
    candidates = extra.filter(candidates)
    candidates = category_access.filter_items(scope, candidates)

    total = len(candidates)
    # Every branch reads projected rows (`_metric_row_read`, or the channel index's), so
    # the page's full reviews are fetched by key, in the window's order.
    page, unread = _batch_get_feedback(candidates[offset:offset + limit])
    window_truncated = window_truncated or unread

    return {
        'count': len(page),
        'total': total,
        'offset': offset,
        'limit': limit,
        'is_partial_window': window_truncated,
        **_walk_partial_fields(),
        'items': page,
    }


def _walk_feedback_days(
    days: int, candidate_cap: int, source: str | None, row_condition: ConditionBase | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """`/feedback`'s day-by-day walk of `gsi1-by-date`: `(candidates, window_truncated)`.

    `source` and `row_condition` are pushed down as FilterExpressions so a day
    dominated by other rows cannot fill the page and starve the in-memory
    filters (issue #99); the walk stops at `candidate_cap` or the time budget.
    """
    candidates: list[dict[str, Any]] = []
    window_truncated = False
    budget = _walk_budget()
    for i, date in enumerate(budgeted_days(days, budget)):
        day_items, day_has_more = _query_partition(
            FEEDBACK_BY_DATE_INDEX,
            Key('gsi1pk').eq(f'DATE#{date}'),
            max_matched=candidate_cap - len(candidates),
            source=source,
            row_condition=row_condition,
            read=_metric_row_read(),
        )
        candidates.extend(day_items)
        if len(candidates) >= candidate_cap:
            # We hit the cap before exhausting the date range.
            window_truncated = day_has_more or i < days - 1
            break
    return candidates, window_truncated or budget.stopped


@app.get("/feedback/urgent")
@tracer.capture_method
@_memoized
def get_urgent_feedback():
    """Get high-urgency feedback items with optional filters.

    One bounded, paged read of the urgency partition (`_query_partition`), then
    ONE BatchGetItem per 100 candidates for the full items — not a `get_item` per
    row, and not a single page (issue #267 item 2).

    The key condition bounds the read to the window server-side: `gsi3sk` is the
    processing timestamp, written in the same instant as `date` (the import-date
    basis), and a review date is never later than its import date, so no row
    older than the cutoff can be admitted on either basis.

    Cursor-paged (`shared/urgent_pages.py`): `next_token` (opaque; absent on the
    last page) resumes after the last index row this page consumed, `has_more`
    says whether one was issued. `count` is THIS page's length. `total` is the
    window's exact match count when it is known for free or for one COUNT read:
    on the first page only, when the page exhausted the window (total = count) or
    when no post-query filter applies (a `Select=COUNT` walk of the same key
    range); otherwise `total` is null and the caller shows "N+" while
    `has_more`. A short read (keys a batch kept unprocessed) is logged.
    """
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    days = _window_days(params, default=30)
    filters = _ItemFilters(params, days, _caller_scope())
    start_key = _urgent_start_key(params.get('next_token'), filters.cutoff_date)

    has_post_filters = _urgent_has_post_filters(filters)
    key_expr = Key('gsi3pk').eq(URGENT_PARTITION) & Key('gsi3sk').gte(filters.cutoff_date)
    page = read_urgent_page(
        lambda key, rows: _urgency_query(key_expr, filters.source, key, rows),
        _batch_get_feedback,
        filters.admits,
        limit=limit,
        start_key=start_key,
        page_rows=min(limit * URGENT_FILTERED_OVERFETCH, DATE_QUERY_LIMIT) if has_post_filters else limit,
        max_scanned=MAX_SCANNED_PER_PARTITION,
    )
    if page.unread:
        logger.info('Urgent feedback page skipped unprocessed keys',
                    extra={'limit': limit, 'returned': len(page.items)})
    total = None
    if start_key is None:
        total = _urgent_total(page, key_expr, filters.source, counted=not has_post_filters)
    return {
        'count': len(page.items),
        'total': total,
        'has_more': page.next_key is not None,
        'next_token': encode_key_cursor(page.next_key) if page.next_key else None,
        'items': page.items,
    }


def _urgent_has_post_filters(filters: _ItemFilters) -> bool:
    """True when an item must be read in full to be admitted.

    `source` is pushed down as a FilterExpression (`source_platform` is projected
    into the index), so it is not one.
    """
    return bool(
        filters.sentiment or filters.category or filters.version or filters.label
        or filters.extra.active
        or filters.date_basis == DATE_BASIS_REVIEW
        or not filters.scope.all
    )


def _urgent_start_key(token: object, cutoff_date: str) -> dict[str, str] | None:
    """The ExclusiveStartKey a `next_token` names; 400 when it is not one this window issued."""
    if token in (None, ''):
        return None
    try:
        key = decode_key_cursor(str(token), URGENCY_KEY_FIELDS, ('gsi3pk', URGENT_PARTITION))
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    if key['gsi3sk'] < cutoff_date:
        raise ValidationError('next_token is not valid')
    return key


def _urgency_kwargs(key_expr, source: str | None, start_key: Mapping[str, Any] | None) -> dict[str, Any]:
    """The urgency-index Query arguments every urgent read shares (source pushed down)."""
    kwargs: dict[str, Any] = {'IndexName': FEEDBACK_BY_URGENCY_INDEX, 'KeyConditionExpression': key_expr}
    if source:
        kwargs['FilterExpression'] = Attr('source_platform').eq(source)
    if start_key:
        kwargs['ExclusiveStartKey'] = dict(start_key)
    return kwargs


def _urgency_query(key_expr, source: str | None, start_key: Mapping[str, str] | None, rows: int) -> Mapping[str, Any]:
    """One newest-first page of the urgency index."""
    return _feedback_table().query(
        **_urgency_kwargs(key_expr, source, start_key), Limit=rows, ScanIndexForward=False,
    )


def _urgent_total(page: UrgentPage, key_expr, source: str | None, *, counted: bool) -> int | None:
    """The first page's window total: exact when known, None when it would need every item read."""
    if page.next_key is None:
        return len(page.items)
    if not counted:
        return None
    total = 0
    scanned = 0
    start_key = None
    while True:
        response = _feedback_table().query(**_urgency_kwargs(key_expr, source, start_key), Select='COUNT')
        total += int(response.get('Count', 0))
        scanned += int(response.get('ScannedCount', 0))
        start_key = response.get('LastEvaluatedKey')
        if not start_key:
            return total
        if scanned >= MAX_SCANNED_PER_PARTITION:
            return None


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
@_memoized
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
            lambda: _metric_window_totals(CATEGORY_PREFIX, configured, days, current_date),
            lambda: _metric_type_totals('source', SOURCE_PREFIX, days, current_date),
            lambda: _metric_type_totals('persona', PERSONA_PREFIX, days, current_date),
            lambda: _metric_window_pair(DAILY_TOTAL_PK, days, current_date),
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
            ScanIndexForward=False,
            **ISSUE_SAMPLE_PROJECTION,
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
@_memoized
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
    offset = _search_offset(params.get('next_token'))

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
        source=filters.source, row_condition=filters.extra.row_condition(),
    )

    # Every match in the scanned window is counted (the candidates are already in
    # memory, so this costs no read), which makes `total` exact for the window the
    # scan reached; `next_token` is an offset into that ordered match list.
    matches = [item for item in candidates if filters.admits(item) and _matches_query(item, query)]
    items = matches[offset:offset + limit]
    next_offset = offset + len(items)
    has_more = bool(items) and next_offset < len(matches)

    return {
        'count': len(items),
        'total': len(matches),
        'has_more': has_more,
        'next_token': encode_offset_cursor(next_offset) if has_more else None,
        'items': items,
        'entities': {
            'categories': _ranked(_tally(matches, 'category', 'other')),
            'sources': _ranked(_tally(matches, 'source_platform', 'unknown')),
            'sentiments': _ranked(_tally(matches, 'sentiment_label', 'neutral')),
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


def _search_offset(token: object) -> int:
    """The match offset a search `next_token` names (0 without one); 400 when it is not one."""
    if token in (None, ''):
        return 0
    try:
        return decode_offset_cursor(str(token), MAX_FEEDBACK_OFFSET)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc


def _matches_query(item: Mapping[str, Any], query: str) -> bool:
    """True when the lower-cased `query` occurs in the item's text, title or problem summary."""
    return any(query in str(item.get(field) or '').lower() for field in SEARCH_TEXT_FIELDS)


@app.get("/feedback/problems")
@tracer.capture_method
@_memoized
def get_problems():
    """The Problem Analysis tree over the WHOLE window (docs/problem-analysis.md).

    The window is the page header's: ``days`` (0 = all time) on ``date_basis``, like
    every other read route. Slim rows (``PROBLEM_READ``) through the caller's scope,
    the source / channel / dims / tag filters and the walk budget; ``category``,
    ``subcategory``, ``urgent`` and ``similarity`` shape the tree
    (``shared.problem_aggregation``).
    """
    params = app.current_event.query_string_parameters or {}
    try:
        query = parse_problem_query(params)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    days = _window_days(params, default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    items, is_partial = _scoped_window_items(
        days, date_basis, _caller_scope(), source=params.get('source'), extra=_extra_filters(params),
        slim=False, read=PROBLEM_READ)
    described = {'kind': 'days', 'days': app.context.get('requested_days'), 'walk_days': days,
                 'date_basis': date_basis}
    return {'period_days': days, 'is_partial': is_partial, **_walk_partial_fields(),
            'window': described, 'type_counts': _feedback_type_counts(items),
            **aggregate_problems(items, query)}


def _feedback_type_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    """Reviews per `feedback_type` dimension value, plus `untyped` (no type yet: before the backfill)."""
    counts: dict[str, int] = {}
    for item in items:
        dims = item.get('dimensions')
        value = dims.get(FEEDBACK_TYPE_KEY) if isinstance(dims, Mapping) else None
        key = value if isinstance(value, str) and value else UNTYPED_COUNT_KEY
        counts[key] = counts.get(key, 0) + 1
    return _ranked(counts)


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
    """Feedback similar to the given one, ranked lexically (`shared/feedback_similarity.py`).

    ONE bounded read: a single Query page of the item's category partition
    (`SIMILAR_CANDIDATE_ROWS` rows). `gsi2sk` is `{sentiment_score}#{timestamp}`, a
    string, so a negative score (leading `-`) sorts before every non-negative one:
    a negative item reads the partition ascending (negatives first), any other
    descending (positives first). The old read always went descending and so
    answered a complaint with the category's most positive reviews.

    The candidates are tiered by language first (the same `original_language`,
    then unknown, then a different one — the text tokens compare the English
    translation, so without tiers a Spanish review would be answered with English
    ones), then ranked within a tier by token overlap and problem-summary overlap,
    boosted for the same sentiment, subcategory and source; a candidate with no
    meaningful overlap is dropped rather than padded in. No model call.
    """
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=8, max_val=50)

    source_item = _feedback_by_id(feedback_id)
    category = source_item.get('category', 'other')

    response = _feedback_table().query(
        IndexName=FEEDBACK_BY_CATEGORY_INDEX,
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=SIMILAR_CANDIDATE_ROWS,
        ScanIndexForward=source_item.get('sentiment_label') == 'negative',
    )

    # Filter the RESULTS too: the partition is keyed on gsi2pk, which is not
    # guaranteed to agree with each item's `category`, so admitting the source
    # item does not admit its neighbours.
    candidates = category_access.filter_items(_caller_scope(), response.get('Items', []))
    similar_items = rank_similar(source_item, candidates, limit)

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
    def filtered(self) -> bool:
        """True when a source / channel / dims / tag filter or the review-date basis narrows the request."""
        return bool(self.source or self.extra.active or self.date_basis == DATE_BASIS_REVIEW)

    @property
    def from_items(self) -> bool:
        return self.filtered or not self.scope.all

    @property
    def category_partitions_answer(self) -> bool:
        """True when the per-category daily counters (`METRIC#daily_category#…`) answer counts exactly.

        They are bucketed by import date, keyed by category and count every source,
        so they serve any category rule but no source rule and no other filter. The
        ONE predicate `/metrics/categories` and `/metrics/summary` share, so the two
        totals come from the same computation for the same scope.
        """
        return self.scope.sources_all and not self.filtered

    def window_items(self) -> tuple[list[dict[str, Any]], bool]:
        """The caller's visible, filtered items of the window (``_scoped_window_items``)."""
        return _scoped_window_items(self.days, self.date_basis, self.scope, source=self.source, extra=self.extra)


def _metric_request() -> _MetricRequest:
    params, days, date_basis = _metrics_window()
    return _MetricRequest(days, date_basis, _caller_scope(), params.get('source'), _extra_filters(params))


def _configured_category_names() -> list[str]:
    """The configured category names (or the defaults), in config order."""
    return get_configured_categories(aggregates_table) or DEFAULT_CATEGORIES


def _visible_category_names(scope: CategoryScope) -> list[str]:
    """Every `METRIC#daily_category#<name>` partition ``scope`` may see.

    The configured categories it admits, in config order, then — for a restricted
    caller — the other names its grant lists (`other`, a removed category), sorted:
    a restricted grant is an explicit list, so these partitions are known without a
    scan. An unrestricted caller's non-configured reviews are not enumerable this
    way; `_category_counter_totals` derives them from `METRIC#daily_total` instead.
    """
    configured = _configured_category_names()
    visible = category_access.visible_categories(scope, configured)
    if scope.categories_all:
        return visible
    return visible + sorted(scope.categories - set(configured))


def _category_counter_totals(scope: CategoryScope, days: int) -> tuple[dict[str, int], bool]:
    """The breakdown from the per-category counters: visible categories plus `other`.

    `other` (`shared.other_category`) is every review no configured category
    claims. For a restricted caller it is the granted non-configured partitions
    (`other`, a removed category). For an unrestricted caller it is
    `METRIC#daily_total` minus the configured categories over the same window:
    the aggregator writes exactly one daily_category row per review beside the
    daily_total row, so the difference is the reviews under `other` or a removed
    category — and the breakdown sums to `/metrics/summary` exactly.
    """
    configured = _configured_category_names()
    if scope.categories_all:
        windows, (total_rows, total_truncated) = concurrently(
            lambda: _visible_category_windows(scope, days),
            lambda: _metric_window_pair(DAILY_TOTAL_PK, days, datetime.now(UTC)),
        )
    else:
        windows, total_rows, total_truncated = _visible_category_windows(scope, days), None, False
    is_partial = total_truncated or any(truncated for _, _, truncated in windows)
    totals = {name: sum(int(row.get('count', 0)) for row in rows) for name, rows, _ in windows}
    if total_rows is not None:
        residual = sum(int(row.get('count', 0)) for row in total_rows) - sum(totals.values())
        totals[other_category.OTHER] = totals.get(other_category.OTHER, 0) + max(residual, 0)
    return other_category.fold_counts(totals, configured), is_partial


def _visible_category_windows(scope: CategoryScope, days: int) -> list[tuple[str, list[dict], bool]]:
    """Each visible category's `METRIC#daily_category#<name>` window as `(name, rows, truncated)`."""
    names = _visible_category_names(scope)
    windows = _metric_windows([f'{CATEGORY_PREFIX}{name}' for name in names], days, datetime.now(UTC))
    return [(name, rows, truncated) for name, (rows, truncated) in zip(names, windows, strict=True)]


def _summary_for_restricted_categories(request: _MetricRequest) -> tuple[list[dict], list[dict], int, bool]:
    """Summary inputs for a category-restricted caller with no other filter.

    The daily totals are the visible categories' pre-computed counters summed per
    day — the same rows `/metrics/categories` sums per category, so both report
    the same total, exact for any window including all time. No counter keeps a
    per-category sentiment score or urgency, so those come from the scoped item
    walk (pushed-down scope; explicitly partial if it cannot finish).
    """
    per_day: dict[str, int] = {}
    truncated = False
    for _name, rows, window_truncated in _visible_category_windows(request.scope, request.days):
        truncated = truncated or window_truncated
        for row in rows:
            per_day[row['sk']] = per_day.get(row['sk'], 0) + int(row.get('count', 0))
    totals = [{'date': day, 'count': count} for day, count in sorted(per_day.items(), reverse=True) if count]
    _, sentiment_data, urgent_count, walk_partial = _summary_from_items(
        request.days, request.date_basis, request.scope)
    return totals, sentiment_data, urgent_count, truncated or walk_partial


@app.get("/metrics/summary")
@tracer.capture_method
@_memoized
def get_summary():
    """Get dashboard summary metrics."""
    request = _metric_request()
    days = request.days
    if request.from_items and request.category_partitions_answer:
        totals, sentiment_data, urgent_count, is_partial = _summary_for_restricted_categories(request)
    elif request.from_items:
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
        _metric_windows([DAILY_TOTAL_PK, SENTIMENT_AVG_PK, 'METRIC#urgent'], days, current_date))
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
@_memoized
def get_sentiment_metrics():
    """Get sentiment breakdown.

    ``category`` narrows the breakdown to one category (the Categories page's
    "Sentiment · <category>" card). It takes the item path, AFTER the caller's
    category filter, so a category the caller may not see answers all zeros —
    the same as any other empty window, never a hint that it exists.
    """
    params, days, date_basis = _metrics_window()
    source = params.get('source')
    category = params.get('category') or None
    extra = _extra_filters(params)
    scope = _caller_scope()

    sentiments = ['positive', 'neutral', 'negative', 'mixed']

    if source or category or extra.active or date_basis == DATE_BASIS_REVIEW or not scope.all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, source=source, extra=extra)
        if category:
            configured = _configured_category_names()
            items = [item for item in items if other_category.matches_category(item, category, configured)]

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
            SENTIMENT_PREFIX, sentiments, days, datetime.now(UTC))

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
@_memoized
def get_category_metrics():
    """Get category breakdown."""
    request = _metric_request()
    # Per-category partitions: a category-restricted caller simply never reads
    # the forbidden ones. A SOURCE restriction cannot be served that way (every
    # partition counts every source), so it takes the item path. The same
    # predicate and partitions back `/metrics/summary`, so their totals agree.
    # Both branches put every review outside the configuration under `other`
    # (shared/other_category.py), so the rows add up to the summary total.
    if not request.category_partitions_answer:
        items, is_partial = request.window_items()
        result = other_category.tally_buckets(items, _configured_category_names())
    else:
        # The reviewer-flagged instance (finding M4): this branch once reported an
        # `is_partial = False` it never computed, so 99 of 6,239 items came back as
        # a complete answer. One partition per category, so truncation in ANY of
        # them makes the breakdown partial.
        result, is_partial = _category_counter_totals(request.scope, request.days)

    return {
        'period_days': request.days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'categories': _ranked(result)
    }


@app.get("/metrics/sources")
@tracer.capture_method
@_memoized
def get_source_metrics():
    """Get source platform breakdown."""
    request = _metric_request()
    days = request.days
    if request.from_items:
        items, is_partial = request.window_items()
        source_totals = _tally(items, 'source_platform', 'unknown')
    else:
        source_totals, is_partial = _metric_type_totals(
            'source', SOURCE_PREFIX, days, datetime.now(UTC))

    return {
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'sources': _ranked(source_totals)
    }


@app.get("/metrics/personas")
@tracer.capture_method
@_memoized
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
        lambda: _metric_window_pair(DAILY_TOTAL_PK, days, current_date),
    )
    total = sum(int(item.get('count', 0)) for item in total_window)
    assigned = sum(sum(labels.values()) for labels in by_value.values())
    return by_value, max(total - assigned, 0), partial or total_truncated


@app.get("/metrics/dimensions")
@tracer.capture_method
@_memoized
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


def _quality_row_read() -> SlimRead:
    """The aggregate routes' slim read plus the stored ``usefulness`` band."""
    read = _aggregate_row_read()
    return replace(read, fields=(*read.fields, USEFULNESS_FIELD))


def _quality_from_counters(days: int) -> tuple[dict[str, Any], bool]:
    """The distribution from the per-source and per-source-band daily counters (two index reads)."""
    current_date = datetime.now(UTC)
    (sources, sources_partial), (bands, bands_partial) = concurrently(
        lambda: _metric_type_totals('source', SOURCE_PREFIX, days, current_date),
        lambda: _metric_type_totals(USEFULNESS_METRIC_TYPE, USEFULNESS_PREFIX, days, current_date),
    )
    return data_quality.from_counters(sources, bands), sources_partial or bands_partial


@app.get("/metrics/data-quality")
@tracer.capture_method
@_memoized
def get_data_quality_metrics():
    """Per-source usefulness distribution ``{source, low, medium, high, unrated, total}`` (docs/data-quality.md).

    The counters answer an unrestricted caller on the import-date basis; a restricted
    caller (category or source rule) or the review basis is counted from the visible
    items, like the sibling routes. Reviews without a band are ``unrated``.
    """
    _params, days, date_basis = _metrics_window()
    scope = _caller_scope()
    if date_basis == DATE_BASIS_REVIEW or not scope.all:
        items, is_partial = _scoped_window_items(days, date_basis, scope, read=_quality_row_read())
        result = data_quality.from_items(items)
    else:
        result, is_partial = _quality_from_counters(days)
    return {
        'period_days': days,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        **result,
    }


@app.get("/metrics/github")
@tracer.capture_method
@_memoized
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


# Release watch: how far back a GitHub release may be found, and the label /
# keyword bounds of a dated launch the caller names.
RELEASE_WATCH_DEFAULT_DAYS = 90
RELEASE_WATCH_MAX_DAYS = 365
RELEASE_WATCH_MAX_LABEL = 120
RELEASE_WATCH_MAX_KEYWORDS = 5


def _optional_text(params: Mapping[str, Any], name: str, limit: int) -> str:
    value = (params.get(name) or '').strip()
    if len(value) > limit:
        raise ValidationError(f'{name} must be at most {limit} characters')
    return value


def _release_watch_releases(params: Mapping[str, Any], days: int, today: datetime) -> tuple[list, int]:
    """The launch the caller named (if any) and the number of days the walk must read."""
    launched_at = params.get('launched_at')
    if launched_at is None:
        return [], days
    if not release_watch.is_iso_day(launched_at):
        raise ValidationError('launched_at must be a YYYY-MM-DD date')
    age = (today.date() - datetime.fromisoformat(launched_at).date()).days
    if age < 0 or age >= RELEASE_WATCH_MAX_DAYS:
        raise ValidationError(f'launched_at must be within the last {RELEASE_WATCH_MAX_DAYS} days')
    label = _optional_text(params, 'label', RELEASE_WATCH_MAX_LABEL) or launched_at
    return [release_watch.launch_release(launched_at, label, launched_at)], age + 1


@app.get("/metrics/release-watch")
@tracer.capture_method
def get_release_watch():
    """Feedback before and after each recent release, regressions flagged in code.

    Releases: the GitHub versions first seen in the last ``days`` days (default 90,
    at most 365), or the one dated launch ``launched_at`` (+ ``label``) names.
    ``window`` (1-60, default 14) is the days compared on each side. ``category``,
    ``q`` (space-separated keywords, all must match), ``source`` and the usual
    channel / dims / tag filters narrow the items. Read-only, after the caller's
    category scope; bounded by the walk's time budget like every per-day walk.
    See ``shared/release_watch.py``.
    """
    params = app.current_event.query_string_parameters or {}
    days = min(_window_days(params, default=RELEASE_WATCH_DEFAULT_DAYS), RELEASE_WATCH_MAX_DAYS)
    window = validate_int(params.get('window'), release_watch.DEFAULT_WINDOW_DAYS, 1, release_watch.MAX_WINDOW_DAYS)
    today = datetime.now(UTC)
    launches, lookback = _release_watch_releases(params, days, today)
    category = _optional_text(params, 'category', RELEASE_WATCH_MAX_LABEL)
    keywords = _optional_text(params, 'q', RELEASE_WATCH_MAX_LABEL).split()[:RELEASE_WATCH_MAX_KEYWORDS]
    # Keyword matching reads the review text, which gsi5-by-channel does not project.
    items, is_partial = _scoped_window_items(
        lookback + window, DATE_BASIS_IMPORTED, _caller_scope(),
        source=params.get('source'), extra=_extra_filters(params), slim=False)
    items = [i for i in items if (not category or i.get('category') == category)
             and release_watch.matches_keywords(i, keywords)]
    since = (today - timedelta(days=days - 1)).strftime('%Y-%m-%d')
    releases = launches or release_watch.github_releases(items, since=since)
    return {
        'period_days': days,
        'window_days': window,
        'is_partial': is_partial,
        **_walk_partial_fields(),
        'thresholds': release_watch.thresholds(),
        'releases': release_watch.release_watch(items, releases, window_days=window, today=today.strftime('%Y-%m-%d')),
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
