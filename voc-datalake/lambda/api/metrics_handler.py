"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

import os
from datetime import datetime, timezone, timedelta
from typing import Any

from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Attr, Key

from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource
from shared.api import (
    create_api_resolver, validate_days, validate_limit, validate_int,
    validate_date_basis, DATE_BASIS_REVIEW, SEARCH_QUERY_MIN_LENGTH,
    get_configured_categories, api_handler, DEFAULT_CATEGORIES,
    AGGREGATE_RETENTION_DAYS,
)
from shared.exceptions import ValidationError
from shared.feedback import (
    PERSONA_FIELD,
    PERSONA_PREFIX,
    PERSONA_UNKNOWN,
    basis_date,
    window_cutoff,
)
from shared.indexes import (
    AGGREGATES_BY_METRIC_TYPE_INDEX,
    FEEDBACK_BY_CATEGORY_INDEX,
    FEEDBACK_BY_DATE_INDEX,
    FEEDBACK_BY_ID_INDEX,
    FEEDBACK_BY_URGENCY_INDEX,
)

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

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

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
        response = feedback_table.query(**kwargs)
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
    """
    items: list[dict[str, Any]] = []
    is_partial = False
    current_date = datetime.now(timezone.utc)
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
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
    return items, is_partial


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
        response = aggregates_table.query(**kwargs)
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


def _window_exceeds_aggregate_retention(days: int) -> bool:
    """True when `days` reaches further back than stored aggregates survive.

    A SECOND, independent reason an aggregates answer can be incomplete, and not
    a variant of the paging one above: paging truncation is a property of one
    read that may or may not happen, while this is a property of the request
    itself and holds even when every read succeeds and returns every row it can.

    Why the horizon exists at all, and why it is narrower than the widest window
    a caller may request, is argued once where the value is declared —
    `AGGREGATE_RETENTION_DAYS` in `shared/api.py`. The consequence here: past that
    horizon the rows are already deleted, so the query succeeds, the totals
    under-report by whatever expired, and nothing in the read notices. Such a
    window simply CANNOT be answered completely from aggregates, which is exactly
    the claim `is_partial` exists to make.

    Strictly greater-than: a window equal to the retention is the widest one the
    rows still cover, so flagging it would cry partial over a complete answer and
    teach callers to ignore the flag.

    The boundary is the GUARANTEE, not the observed state: DynamoDB deletes
    expired items on its own schedule, typically within 48 hours of the TTL, so a
    window just past the horizon will sometimes still be answerable in full and
    get reported partial anyway. That is the safe direction to be wrong in — a
    lower bound presented as a lower bound — and the alternative is asking the
    table whether the rows are still there, which is a read per date and answers
    a question the caller did not ask.
    """
    return days > AGGREGATE_RETENTION_DAYS


def _index_read_was_truncated(response: dict) -> bool:
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

    The scan path exists because aggregates are bucketed by import date only, so a
    review-date window or a source filter has to be computed from raw items — and
    that makes this function the read side's answer to the same question
    `aggregator/handler.py::counter_dimensions` answers when it names a
    `METRIC#persona#<value>` row. The two must agree, or `/metrics/personas`
    reports one thing for `?date_basis=review` and another for the default basis
    over the same items. One window, two code paths, two different answers is the
    defect class this file has now been repaired for twice, so the field and the
    empty-bucket name are IMPORTED from `shared/feedback.py` rather than spelled
    here: the aggregator imports the same two constants, and
    test_persona_dimension_lockstep.py fails if either side reads anything else.

    Why the field is the archetype and not the name is argued where the constant is
    declared. The short of it: `persona_name` is legitimately null for anonymous
    feedback, which is most of this corpus, so bucketing by it put 99.97% of a
    6,239-item corpus in one bucket.

    `or`, not a `.get` default, and for the aggregator's reason: an item can carry
    an explicit None, which a default would not replace.

    WHY THE DERIVATION IS DUPLICATED HERE rather than shared alongside the two
    constants — considered, and rejected: that `or` reasoning is a property of this
    one expression and reads differently on each side (there, what a stream image
    can hold; here, what the scan path answers), so a shared helper would move it
    one import away from both readers to remove two lines that are already pinned to
    each other. See the note beside PERSONA_UNKNOWN in `shared/feedback.py`.
    """
    return item.get(PERSONA_FIELD) or PERSONA_UNKNOWN


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

    days = validate_days(params.get('days'), default=7)
    date_basis = validate_date_basis(params.get('date_basis'))
    source = params.get('source')
    category = params.get('category')
    sentiment = params.get('sentiment')
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
    has_post_filter = (
        bool(source) or bool(sentiment) or bool(category)
        or date_basis == DATE_BASIS_REVIEW
    )
    candidate_cap = (
        MAX_FEEDBACK_OFFSET if has_post_filter
        else max((offset + limit) * 2, MIN_CANDIDATE_CAP)
    )

    candidates: list[dict[str, Any]] = []
    current_date = datetime.now(timezone.utc)
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
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
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

    total = len(candidates)
    page = candidates[offset:offset + limit]

    return {
        'count': len(page),
        'total': total,
        'offset': offset,
        'limit': limit,
        'is_partial_window': window_truncated,
        'items': page,
    }


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items with optional filters."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    # Unified window definition: a days-long window ending today (same as
    # /feedback and /metrics/*). Previously spanned days+1 calendar days.
    cutoff_date = window_cutoff(days)
    
    has_filters = bool(
        source_filter or sentiment_filter or category_filter
        or date_basis == DATE_BASIS_REVIEW
    )
    fetch_limit = limit * 5 if has_filters else limit
    
    response = feedback_table.query(
        IndexName=FEEDBACK_BY_URGENCY_INDEX,
        KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
        Limit=fetch_limit,
        ScanIndexForward=False
    )
    
    items = []
    for gsi_item in response.get('Items', []):
        pk, sk = gsi_item.get('pk'), gsi_item.get('sk')
        if not pk or not sk:
            continue
        
        full_item = feedback_table.get_item(Key={'pk': pk, 'sk': sk})
        item = full_item.get('Item')
        if not item:
            continue
        
        if basis_date(item, date_basis) < cutoff_date:
            continue
        if source_filter and item.get('source_platform') != source_filter:
            continue
        if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
            continue
        if category_filter and item.get('category') != category_filter:
            continue
        
        items.append(item)
        if len(items) >= limit:
            break
    
    # NOTE: `count` is this page's length, NOT the number of urgent items in the
    # window — the scan above stops once `limit` items are collected, so `count`
    # is bounded by `limit`. Do not read it as a total: the sidebar urgent badge
    # did exactly that with limit=10 and could never display more than 10.
    # For a true total use /metrics/summary's `urgent_count`, which sums the
    # exact METRIC#urgent daily aggregates. Renaming this field (or adding a
    # companion `total`/`has_more`) is an API change left to its own commit;
    # `test_count_is_the_returned_page_length_not_the_window_total` pins the
    # current semantics so the constraint is discoverable.
    return {'count': len(items), 'items': items[:limit]}


@app.get("/feedback/entities")
@tracer.capture_method
def get_entities():
    """Get entity extraction for chat filters."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=7)
    limit = validate_limit(params.get('limit'), default=100, max_val=200)
    source = params.get('source')
    date_basis = validate_date_basis(params.get('date_basis'))
    
    current_date = datetime.now(timezone.utc)
    
    # Aggregates are bucketed by import date only, so both the source filter
    # and the review-date basis require computing entities from raw items.
    if source or date_basis == DATE_BASIS_REVIEW:
        items, is_partial = _scan_window_items(days, date_basis, source=source)
        
        category_counts = {}
        issues = {}
        source_counts = {}
        persona_counts = {}
        for item in items:
            category = item.get('category', 'other')
            category_counts[category] = category_counts.get(category, 0) + 1
            src = item.get('source_platform', 'unknown')
            source_counts[src] = source_counts.get(src, 0) + 1
            # Counted for EVERY item, including the ones with no archetype, because
            # the aggregates branch below counts every item too — the aggregator
            # writes exactly one persona counter per item. Skipping the empty ones
            # here would make the two branches of one route disagree about the same
            # window, which is what `_persona_bucket` exists to prevent.
            persona = _persona_bucket(item)
            persona_counts[persona] = persona_counts.get(persona, 0) + 1
            problem = item.get('problem_summary', '')
            if problem and len(problem) > 5:
                problem_key = problem[:100].lower().strip()
                issues[problem_key] = issues.get(problem_key, 0) + 1
        
        return {
            'period_days': days,
            'feedback_count': len(items),
            'is_partial': is_partial,
            'entities': {
                'keywords': {},
                'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
                'issues': dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20]),
                'personas': dict(sorted(persona_counts.items(), key=lambda x: x[1], reverse=True)),
                'sources': dict(sorted(source_counts.items(), key=lambda x: x[1], reverse=True)),
            }
        }
    
    # The aggregates path. `is_partial` is computed here, exactly as the scan
    # path above computes it, rather than left to the `False` this response used
    # to omit its way into: a reader cannot tell an absent flag from a false one.
    is_partial = _window_exceeds_aggregate_retention(days)

    # Get categories from aggregates
    categories_list = get_configured_categories(aggregates_table)
    category_counts = {}
    for category in categories_list:
        window, truncated = _query_metric_window(
            f'METRIC#daily_category#{category}', days, current_date)
        is_partial = is_partial or truncated
        total = sum(int(item.get('count', 0)) for item in window)
        if total > 0:
            category_counts[category] = total

    # Get sources from aggregates
    source_response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('source')
    )
    is_partial = is_partial or _index_read_was_truncated(source_response)
    source_totals = {}
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    for item in source_response.get('Items', []):
        if item.get('sk') in date_range:
            src = item['pk'].replace('METRIC#daily_source#', '')
            source_totals[src] = source_totals.get(src, 0) + int(item.get('count', 0))
    
    # Get personas from aggregates
    persona_response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('persona')
    )
    is_partial = is_partial or _index_read_was_truncated(persona_response)
    persona_counts = {}
    for item in persona_response.get('Items', []):
        if item.get('sk') in date_range:
            # PERSONA_PREFIX, shared with the aggregator that BUILT this pk: two
            # Lambdas that cannot import each other must strip exactly what the
            # other prepended, or the bucket names come back mangled.
            persona = item['pk'].replace(PERSONA_PREFIX, '')
            persona_counts[persona] = persona_counts.get(persona, 0) + int(item.get('count', 0))

    # Get feedback count
    total_window, total_truncated = _query_metric_window(
        'METRIC#daily_total', days, current_date)
    is_partial = is_partial or total_truncated
    feedback_count = sum(int(item.get('count', 0)) for item in total_window)

    # Extract issues from recent feedback
    issues = {}
    feedback_items = []
    for i in range(min(days, 7)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName=FEEDBACK_BY_DATE_INDEX,
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=50,
            ScanIndexForward=False
        )
        feedback_items.extend(response.get('Items', []))
        if len(feedback_items) >= limit:
            break
    
    for item in feedback_items[:limit]:
        problem = item.get('problem_summary', '')
        if problem and len(problem) > 5:
            problem_key = problem[:100].lower().strip()
            issues[problem_key] = issues.get(problem_key, 0) + 1
    
    # `is_partial` describes the COUNTS (categories, sources, personas,
    # feedback_count), which is what the scan branch's flag describes too. The
    # `issues` map is a deliberate sample on both branches — the newest rows of
    # at most seven days, capped at `limit` — and is not what this flag is about;
    # folding that in would make it true on nearly every call and so mean nothing.
    return {
        'period_days': days,
        'feedback_count': feedback_count,
        'is_partial': is_partial,
        'entities': {
            'keywords': {},
            'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
            'issues': dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20]),
            'personas': dict(sorted(persona_counts.items(), key=lambda x: x[1], reverse=True)),
            'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True)),
        }
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
    
    days = validate_days(params.get('days'), default=30)
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    date_basis = validate_date_basis(params.get('date_basis'))
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    # Unified window definition: a days-long window ending today (same as
    # /feedback and /metrics/*). Previously spanned days+1 calendar days.
    cutoff_date = window_cutoff(days)
    
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
        source=source_filter,
    )
    
    items = []
    for item in candidates:
        if basis_date(item, date_basis) < cutoff_date:
            continue
        if source_filter and item.get('source_platform') != source_filter:
            continue
        if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
            continue
        if category_filter and item.get('category') != category_filter:
            continue
        
        original_text = (item.get('original_text') or '').lower()
        title = (item.get('title') or '').lower()
        problem_summary = (item.get('problem_summary') or '').lower()
        
        if query in original_text or query in title or query in problem_summary:
            items.append(item)
            if len(items) >= limit:
                break
    
    # Build entities summary
    category_counts, source_counts, sentiment_counts = {}, {}, {}
    for item in items:
        cat = item.get('category', 'other')
        category_counts[cat] = category_counts.get(cat, 0) + 1
        src = item.get('source_platform', 'unknown')
        source_counts[src] = source_counts.get(src, 0) + 1
        sent = item.get('sentiment_label', 'neutral')
        sentiment_counts[sent] = sentiment_counts.get(sent, 0) + 1
    
    return {
        'count': len(items),
        'items': items,
        'entities': {
            'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
            'sources': dict(sorted(source_counts.items(), key=lambda x: x[1], reverse=True)),
            'sentiments': dict(sorted(sentiment_counts.items(), key=lambda x: x[1], reverse=True)),
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
    }


@app.get("/feedback/<feedback_id>")
@tracer.capture_method
def get_feedback(feedback_id: str):
    """Get a single feedback item by ID."""
    response = feedback_table.query(
        IndexName=FEEDBACK_BY_ID_INDEX,
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    items = response.get('Items', [])
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    return items[0]


@app.get("/feedback/<feedback_id>/similar")
@tracer.capture_method
def get_similar_feedback(feedback_id: str):
    """Get feedback items similar to the given one."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=8, max_val=50)
    
    response = feedback_table.query(
        IndexName=FEEDBACK_BY_ID_INDEX,
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    items = response.get('Items', [])
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    source_item = items[0]
    category = source_item.get('category', 'other')
    
    response = feedback_table.query(
        IndexName=FEEDBACK_BY_CATEGORY_INDEX,
        KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
        Limit=limit + 10,
        ScanIndexForward=False
    )
    
    similar_items = [item for item in response.get('Items', []) if item.get('feedback_id') != feedback_id][:limit]
    
    return {
        'source_feedback_id': feedback_id,
        'count': len(similar_items),
        'items': similar_items
    }


# ============================================
# Metrics Endpoints
# ============================================

def _summary_from_items(days: int) -> dict:
    """Compute summary metrics bucketed by review date from raw feedback.

    Pre-computed aggregates are bucketed by import date only, so the
    review-date basis derives daily totals, sentiment averages, and urgent
    counts on the fly (same approach as the source-filtered metric branches).
    The scan budget matches /feedback's candidate cap so both endpoints
    describe the same window; `is_partial` is set when the scan truncated
    and the numbers are a lower bound.
    """
    items, is_partial = _scan_window_items(days, DATE_BASIS_REVIEW)

    daily_counts: dict[str, int] = {}
    daily_sentiment: dict[str, dict[str, float]] = {}
    urgent_count = 0
    for item in items:
        day = basis_date(item, DATE_BASIS_REVIEW)
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
        if bucket['count'] > 0
    ]

    total_feedback = len(items)
    weighted_sum = sum(s['avg_sentiment'] * s['count'] for s in sentiment_data)
    avg_sentiment = weighted_sum / max(total_feedback, 1)

    return {
        'period_days': days,
        'total_feedback': total_feedback,
        'avg_sentiment': round(avg_sentiment, 3),
        'urgent_count': urgent_count,
        'is_partial': is_partial,
        'daily_totals': totals,
        'daily_sentiment': sentiment_data,
    }


@app.get("/metrics/summary")
@tracer.capture_method
def get_summary():
    """Get dashboard summary metrics."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    
    if date_basis == DATE_BASIS_REVIEW:
        return _summary_from_items(days)
    
    current_date = datetime.now(timezone.utc)

    # Three partitions, one flag: a short read of ANY of them makes the summary
    # incomplete, so they OR rather than each reporting for themselves. The
    # review-basis branch above already returns `is_partial` from its scan; this
    # branch used to omit the key entirely, which a caller reads as "complete".
    is_partial = _window_exceeds_aggregate_retention(days)

    total_items, total_truncated = _query_metric_window(
        'METRIC#daily_total', days, current_date)
    is_partial = is_partial or total_truncated
    totals = [
        {'date': item['sk'], 'count': item.get('count', 0)}
        for item in total_items
    ]

    sentiment_items, sentiment_truncated = _query_metric_window(
        'METRIC#daily_sentiment_avg', days, current_date)
    is_partial = is_partial or sentiment_truncated
    sentiment_data = []
    for item in sentiment_items:
        if item.get('count', 0) > 0:
            avg = float(item.get('sum', 0)) / float(item.get('count', 1))
            sentiment_data.append({'date': item['sk'], 'avg_sentiment': round(avg, 3), 'count': item.get('count')})

    urgent_items, urgent_truncated = _query_metric_window(
        'METRIC#urgent', days, current_date)
    is_partial = is_partial or urgent_truncated
    urgent_count = sum(item.get('count', 0) for item in urgent_items)

    total_feedback = sum(int(t.get('count', 0)) for t in totals)
    avg_sentiment = sum(float(s.get('avg_sentiment', 0)) * int(s.get('count', 0)) for s in sentiment_data) / max(total_feedback, 1)

    return {
        'period_days': days,
        'total_feedback': total_feedback,
        'avg_sentiment': round(avg_sentiment, 3),
        'urgent_count': urgent_count,
        'is_partial': is_partial,
        'daily_totals': totals,
        'daily_sentiment': sentiment_data
    }


@app.get("/metrics/sentiment")
@tracer.capture_method
def get_sentiment_metrics():
    """Get sentiment breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    source = params.get('source')
    
    sentiments = ['positive', 'neutral', 'negative', 'mixed']
    result = {s: 0 for s in sentiments}
    is_partial = False
    current_date = datetime.now(timezone.utc)
    
    if source or date_basis == DATE_BASIS_REVIEW:
        items, is_partial = _scan_window_items(days, date_basis, source=source)
        
        for item in items:
            sentiment = item.get('sentiment_label', 'neutral')
            if sentiment in result:
                result[sentiment] += 1
    else:
        # One partition per label, and a short read of any one of them leaves the
        # breakdown (and therefore `total` and every percentage) understated, so
        # truncation ORs across labels rather than being attributed to one.
        is_partial = _window_exceeds_aggregate_retention(days)
        for sentiment in sentiments:
            window, truncated = _query_metric_window(
                f'METRIC#daily_sentiment#{sentiment}', days, current_date)
            is_partial = is_partial or truncated
            result[sentiment] = sum(int(item.get('count', 0)) for item in window)

    total = sum(result.values())
    return {
        'period_days': days,
        'total': total,
        'is_partial': is_partial,
        'breakdown': result,
        'percentages': {k: round(v / max(total, 1) * 100, 1) for k, v in result.items()}
    }


@app.get("/metrics/categories")
@tracer.capture_method
def get_category_metrics():
    """Get category breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    source = params.get('source')
    
    categories = get_configured_categories(aggregates_table)
    if not categories:
        categories = DEFAULT_CATEGORIES
    
    result = {}
    is_partial = False
    current_date = datetime.now(timezone.utc)
    
    if source or date_basis == DATE_BASIS_REVIEW:
        items, is_partial = _scan_window_items(days, date_basis, source=source)
        
        for item in items:
            category = item.get('category', 'other')
            result[category] = result.get(category, 0) + 1
    else:
        # The reviewer-flagged instance (finding M4): this branch reported the
        # `is_partial = False` initialised above without ever computing it, so 99
        # of 6,239 items came back as a complete answer. One partition per
        # category, so truncation in ANY of them makes the breakdown partial.
        is_partial = _window_exceeds_aggregate_retention(days)
        for category in categories:
            window, truncated = _query_metric_window(
                f'METRIC#daily_category#{category}', days, current_date)
            is_partial = is_partial or truncated
            total = sum(int(item.get('count', 0)) for item in window)
            if total > 0:
                result[category] = total

    return {
        'period_days': days,
        'is_partial': is_partial,
        'categories': dict(sorted(result.items(), key=lambda x: x[1], reverse=True))
    }


@app.get("/metrics/sources")
@tracer.capture_method
def get_source_metrics():
    """Get source platform breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    
    if date_basis == DATE_BASIS_REVIEW:
        # Aggregates are bucketed by import date; compute from raw items.
        items, is_partial = _scan_window_items(days, date_basis)
        source_totals = {}
        for item in items:
            source = item.get('source_platform', 'unknown')
            source_totals[source] = source_totals.get(source, 0) + 1
        return {
            'period_days': days,
            'is_partial': is_partial,
            'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True))
        }
    
    response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('source')
    )
    is_partial = (
        _window_exceeds_aggregate_retention(days)
        or _index_read_was_truncated(response)
    )

    source_totals = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))

    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            source = item['pk'].replace('METRIC#daily_source#', '')
            source_totals[source] = source_totals.get(source, 0) + int(item.get('count', 0))

    return {
        'period_days': days,
        'is_partial': is_partial,
        'sources': dict(sorted(source_totals.items(), key=lambda x: x[1], reverse=True))
    }


@app.get("/metrics/personas")
@tracer.capture_method
def get_persona_metrics():
    """Get persona breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    date_basis = validate_date_basis(params.get('date_basis'))
    
    if date_basis == DATE_BASIS_REVIEW:
        # Aggregates are bucketed by import date; compute from raw items.
        items, is_partial = _scan_window_items(days, date_basis)
        personas = {}
        for item in items:
            # Every item, empty archetype included — see `_persona_bucket` and the
            # note in `/feedback/entities`: the aggregates branch below counts one
            # persona row per item, so a scan branch that dropped the empty ones
            # would answer a different question over the same window.
            persona = _persona_bucket(item)
            personas[persona] = personas.get(persona, 0) + 1
        return {
            'period_days': days,
            'is_partial': is_partial,
            'personas': dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
        }
    
    response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('persona')
    )
    is_partial = (
        _window_exceeds_aggregate_retention(days)
        or _index_read_was_truncated(response)
    )

    personas = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))

    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            # PERSONA_PREFIX, shared with the aggregator that BUILT this pk — see
            # the same read in `get_entities`.
            persona = item['pk'].replace(PERSONA_PREFIX, '')
            personas[persona] = personas.get(persona, 0) + int(item.get('count', 0))

    return {
        'period_days': days,
        'is_partial': is_partial,
        'personas': dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
    }


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
