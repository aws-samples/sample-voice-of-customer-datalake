"""
VoC Metrics API Lambda
Handles read-only queries: /feedback/*, /metrics/*
Split from main handler to reduce Lambda resource policy size.
"""

import os
from datetime import datetime, timezone, timedelta
from typing import Any

from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource
from shared.api import (
    create_api_resolver, validate_days, validate_limit,
    get_configured_categories, api_handler, DEFAULT_CATEGORIES
)

from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key

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
# Feedback Endpoints
# ============================================

@app.get("/feedback")
@tracer.capture_method
def list_feedback():
    """List feedback with optional filters."""
    params = app.current_event.query_string_parameters or {}
    
    days = validate_days(params.get('days'), default=7)
    source = params.get('source')
    category = params.get('category')
    sentiment = params.get('sentiment')
    limit = validate_limit(params.get('limit'), default=50, max_val=100)
    
    items = []
    current_date = datetime.now(timezone.utc)
    
    if category and not source:
        response = feedback_table.query(
            IndexName='gsi2-by-category',
            KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
            Limit=limit * 2,
            ScanIndexForward=False
        )
        items = response.get('Items', [])
    else:
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit * 5:
                break
    
    if source:
        items = [i for i in items if i.get('source_platform') == source]
    if category and source:
        items = [i for i in items if i.get('category') == category]
    if sentiment:
        items = [i for i in items if i.get('sentiment_label') == sentiment]
    
    return {'count': len(items), 'items': items[:limit]}


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
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        items = [i for i in items if i.get('source_platform') == source]
        
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
    
    candidates = []
    for i in range(min(days, 30)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=300,
            ScanIndexForward=False
        )
        candidates.extend(response.get('Items', []))
        if len(candidates) >= 1000:
            break
    
    items = []
    for item in candidates:
        if item.get('date', '') < cutoff_date:
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
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        for item in items:
            if item.get('source_platform') == source:
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
        items = []
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= 1000:
                break
        
        for item in items:
            if item.get('source_platform') == source:
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
