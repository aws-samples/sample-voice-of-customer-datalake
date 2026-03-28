"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

from datetime import datetime, timezone, timedelta
from typing import Any

from shared.logging import logger, tracer
from shared.api import (
    create_api_resolver, validate_days, validate_limit, validate_int,
    get_configured_categories, api_handler, DEFAULT_CATEGORIES
)
from shared.exceptions import NotFoundError
from shared.feedback import query_feedback_by_date, query_feedback_page
from shared.tables import get_feedback_table, get_aggregates_table
from boto3.dynamodb.conditions import Key

feedback_table = get_feedback_table()
aggregates_table = get_aggregates_table()

# API resolver with standard CORS
app = create_api_resolver()


# ============================================
# Feedback Endpoints
# ============================================

@app.get("/feedback")
@tracer.capture_method
def list_feedback():
    """List feedback with optional filters and pagination."""
    params = app.current_event.query_string_parameters or {}
    
    days = validate_days(params.get('days'), default=7)
    source = params.get('source')
    category_param = params.get('category')
    sentiment = params.get('sentiment')
    limit = validate_limit(params.get('limit'), default=50, max_val=500)
    offset = validate_int(params.get('offset'), default=0, min_val=0, max_val=10000)
    
    # Support comma-separated categories (e.g. "ease_of_use,delivery")
    categories = [c.strip() for c in category_param.split(',') if c.strip()] if category_param else []
    
    page, total = query_feedback_page(
        feedback_table,
        days=days,
        sources=[source] if source else None,
        categories=categories or None,
        sentiments=[sentiment] if sentiment else None,
        limit=limit,
        offset=offset,
    )
    
    return {'count': len(page), 'total': total, 'offset': offset, 'limit': limit, 'items': page}


@app.get("/feedback/urgent")
@tracer.capture_method
def get_urgent_feedback():
    """Get high-urgency feedback items with optional filters."""
    params = app.current_event.query_string_parameters or {}
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    days = validate_days(params.get('days'), default=30)
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    fetch_limit = limit * 5 if (source_filter or sentiment_filter or category_filter) else limit
    
    response = feedback_table.query(
        IndexName='gsi3-by-urgency',
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
        
        if item.get('date', '') < cutoff_date:
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
    
    current_date = datetime.now(timezone.utc)
    
    if source:
        items = query_feedback_by_date(
            feedback_table, days=days, sources=[source], limit=5000,
        )
        
        category_counts = {}
        issues = {}
        for item in items:
            category = item.get('category', 'other')
            category_counts[category] = category_counts.get(category, 0) + 1
            problem = item.get('problem_summary', '')
            if problem and len(problem) > 5:
                problem_key = problem[:100].lower().strip()
                issues[problem_key] = issues.get(problem_key, 0) + 1
        
        return {
            'period_days': days,
            'feedback_count': len(items),
            'entities': {
                'keywords': {},
                'categories': dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)),
                'issues': dict(sorted(issues.items(), key=lambda x: x[1], reverse=True)[:20]),
                'personas': {},
                'sources': {source: len(items)} if items else {},
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
        IndexName='gsi1-by-metric-type',
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
        IndexName='gsi1-by-metric-type',
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
            IndexName='gsi1-by-date',
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
    source_filter = params.get('source')
    sentiment_filter = params.get('sentiment')
    category_filter = params.get('category')
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    candidates = query_feedback_by_date(
        feedback_table,
        days=days,
        sources=[source_filter] if source_filter else None,
        categories=[category_filter] if category_filter else None,
        sentiments=[sentiment_filter] if sentiment_filter else None,
        limit=1000,
        per_day_limit=300,
    )
    
    items = []
    for item in candidates:
        if item.get('date', '') < cutoff_date:
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
        IndexName='gsi4-by-feedback-id',
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
        IndexName='gsi4-by-feedback-id',
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1
    )
    items = response.get('Items', [])
    if not items:
        raise NotFoundError(f"Feedback {feedback_id} not found")
    
    source_item = items[0]
    category = source_item.get('category', 'other')
    
    response = feedback_table.query(
        IndexName='gsi2-by-category',
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

@app.get("/metrics/summary")
@tracer.capture_method
def get_summary():
    """Get dashboard summary metrics."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    
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
    source = params.get('source')
    
    sentiments = ['positive', 'neutral', 'negative', 'mixed']
    result = {s: 0 for s in sentiments}
    current_date = datetime.now(timezone.utc)
    
    if source:
        items = query_feedback_by_date(
            feedback_table, days=days, sources=[source], limit=5000,
        )
        
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
        'breakdown': result,
        'percentages': {k: round(v / max(total, 1) * 100, 1) for k, v in result.items()}
    }


@app.get("/metrics/categories")
@tracer.capture_method
def get_category_metrics():
    """Get category breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    source = params.get('source')
    
    categories = get_configured_categories(aggregates_table)
    if not categories:
        categories = DEFAULT_CATEGORIES
    
    result = {}
    current_date = datetime.now(timezone.utc)
    
    if source:
        items = query_feedback_by_date(
            feedback_table, days=days, sources=[source], limit=5000,
        )
        
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
        'categories': dict(sorted(result.items(), key=lambda x: x[1], reverse=True))
    }


@app.get("/metrics/sources")
@tracer.capture_method
def get_source_metrics():
    """Get source platform breakdown."""
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=30)
    
    response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
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
    
    response = aggregates_table.query(
        IndexName='gsi1-by-metric-type',
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
# Problem Resolution Endpoints
# ============================================

@app.get("/feedback/problems/resolved")
@tracer.capture_method
def list_resolved_problems():
    """List all resolved problem IDs."""
    if not aggregates_table:
        return {'resolved': []}

    response = aggregates_table.query(
        KeyConditionExpression=Key('pk').eq('RESOLVED_PROBLEMS') & Key('sk').begins_with('PROBLEM#')
    )

    resolved = []
    for item in response.get('Items', []):
        resolved.append({
            'problem_id': item['sk'].replace('PROBLEM#', ''),
            'category': item.get('category', ''),
            'subcategory': item.get('subcategory', ''),
            'problem_text': item.get('problem_text', ''),
            'resolved_at': item.get('resolved_at', ''),
            'resolved_by': item.get('resolved_by', ''),
        })

    return {'resolved': resolved}


@app.put("/feedback/problems/<problem_id>/resolve")
@tracer.capture_method
def resolve_problem(problem_id: str):
    """Mark a problem group as resolved."""
    if not aggregates_table:
        return {'success': False, 'error': 'Aggregates table not configured'}

    body = app.current_event.json_body or {}
    category = body.get('category', '')
    subcategory = body.get('subcategory', '')
    problem_text = body.get('problem_text', '')

    now = datetime.now(timezone.utc).isoformat()

    # Extract user from Cognito claims if available
    resolved_by = ''
    try:
        request_context = app.current_event.request_context
        claims = request_context.authorizer.get('claims', {}) if request_context.authorizer else {}
        resolved_by = claims.get('email', claims.get('cognito:username', ''))
    except Exception:
        pass

    aggregates_table.put_item(Item={
        'pk': 'RESOLVED_PROBLEMS',
        'sk': f'PROBLEM#{problem_id}',
        'category': category,
        'subcategory': subcategory,
        'problem_text': problem_text,
        'resolved_at': now,
        'resolved_by': resolved_by,
    })

    logger.info(f"Problem {problem_id} marked as resolved by {resolved_by}")

    return {'success': True, 'problem_id': problem_id, 'resolved_at': now}


@app.delete("/feedback/problems/<problem_id>/resolve")
@tracer.capture_method
def unresolve_problem(problem_id: str):
    """Unresolve a previously resolved problem group."""
    if not aggregates_table:
        return {'success': False, 'error': 'Aggregates table not configured'}

    aggregates_table.delete_item(Key={
        'pk': 'RESOLVED_PROBLEMS',
        'sk': f'PROBLEM#{problem_id}',
    })

    logger.info(f"Problem {problem_id} marked as unresolved")

    return {'success': True, 'problem_id': problem_id}


# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
