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

from shared.logging import tracer
from shared.aws import get_dynamodb_resource
from shared.api import (
    create_api_resolver, validate_days, validate_limit, validate_int,
    validate_date_basis, DATE_BASIS_REVIEW,
    get_configured_categories, api_handler, DEFAULT_CATEGORIES
)
from shared.feedback import basis_date, window_cutoff
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
            persona_name = item.get('persona_name')
            if persona_name:
                persona_counts[persona_name] = persona_counts.get(persona_name, 0) + 1
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
    
    # Get categories from aggregates
    categories_list = get_configured_categories(aggregates_table)
    category_counts = {}
    for category in categories_list:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
            item = response.get('Item')
            if item:
                total += int(item.get('count', 0))
        if total > 0:
            category_counts[category] = total
    
    # Get sources from aggregates
    source_response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('source')
    )
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
    persona_counts = {}
    for item in persona_response.get('Items', []):
        if item.get('sk') in date_range:
            persona_name = item['pk'].replace('METRIC#persona#', '')
            persona_counts[persona_name] = persona_counts.get(persona_name, 0) + int(item.get('count', 0))
    
    # Get feedback count
    feedback_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            feedback_count += int(item.get('count', 0))
    
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
    
    return {
        'period_days': days,
        'feedback_count': feedback_count,
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
    if not query or len(query) < 2:
        return {'count': 0, 'items': [], 'entities': {}, 'query': query}
    
    days = validate_days(params.get('days'), default=30)
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    date_basis = validate_date_basis(params.get('date_basis'))
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    # Unified window definition: a days-long window ending today (same as
    # /feedback and /metrics/*). Previously spanned days+1 calendar days.
    cutoff_date = window_cutoff(days)
    
    candidates, _ = _scan_recent_items(
        # Sampling scan: search text-matches within a bounded recent sample,
        # so it keeps the smaller legacy budget rather than the full window.
        min(days, 30), per_day_limit=300, soft_cap=CANDIDATES_SOFT_CAP,
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
        'query': query
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
    
    totals = []
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            totals.append({'date': date, 'count': item.get('count', 0)})
    
    sentiment_data = []
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_sentiment_avg', 'sk': date})
        item = response.get('Item')
        if item and item.get('count', 0) > 0:
            avg = float(item.get('sum', 0)) / float(item.get('count', 1))
            sentiment_data.append({'date': date, 'avg_sentiment': round(avg, 3), 'count': item.get('count')})
    
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#urgent', 'sk': date})
        item = response.get('Item')
        if item:
            urgent_count += item.get('count', 0)
    
    total_feedback = sum(int(t.get('count', 0)) for t in totals)
    avg_sentiment = sum(float(s.get('avg_sentiment', 0)) * int(s.get('count', 0)) for s in sentiment_data) / max(total_feedback, 1)
    
    return {
        'period_days': days,
        'total_feedback': total_feedback,
        'avg_sentiment': round(avg_sentiment, 3),
        'urgent_count': urgent_count,
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
        for sentiment in sentiments:
            total = 0
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date})
                item = response.get('Item')
                if item:
                    total += int(item.get('count', 0))
            result[sentiment] = total
    
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
        for category in categories:
            total = 0
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
                item = response.get('Item')
                if item:
                    total += item.get('count', 0)
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
    
    source_totals = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    
    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            source = item['pk'].replace('METRIC#daily_source#', '')
            source_totals[source] = source_totals.get(source, 0) + int(item.get('count', 0))
    
    return {
        'period_days': days,
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
            persona_name = item.get('persona_name')
            if persona_name:
                personas[persona_name] = personas.get(persona_name, 0) + 1
        return {
            'period_days': days,
            'is_partial': is_partial,
            'personas': dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
        }
    
    response = aggregates_table.query(
        IndexName=AGGREGATES_BY_METRIC_TYPE_INDEX,
        KeyConditionExpression=Key('metric_type').eq('persona')
    )
    
    personas = {}
    current_date = datetime.now(timezone.utc)
    date_range = set((current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days))
    
    for item in response.get('Items', []):
        if item.get('sk') in date_range:
            persona_name = item['pk'].replace('METRIC#persona#', '')
            personas[persona_name] = personas.get(persona_name, 0) + int(item.get('count', 0))
    
    return {
        'period_days': days,
        'personas': dict(sorted(personas.items(), key=lambda x: x[1], reverse=True))
    }


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
