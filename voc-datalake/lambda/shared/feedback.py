"""
Shared feedback utilities for LLM context building and API queries.
Used by metrics API, projects API, research step handler, MCP handler,
and job Lambdas (document generator, document merger).
"""

import logging
from datetime import datetime, timezone, timedelta
from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)

# Maximum number of days to look back when querying by date
MAX_LOOKBACK_DAYS = 90


def _fetch_and_filter(
    feedback_table,
    days: int,
    sources: list[str],
    categories: list[str],
    sentiments: list[str],
    fetch_ceiling: int,
    per_day_limit: int,
) -> list[dict]:
    """Internal: fetch items from DynamoDB and apply in-memory filters.

    Args:
        fetch_ceiling: When no post-filters are active, stop querying
            once we have this many raw items (early-break optimisation).
            Pass 0 to disable early break (scan all dates).
    """
    has_post_filters = bool(sources or sentiments)
    items: list[dict] = []
    current_date = datetime.now(timezone.utc)

    if categories and not sources:
        per_cat = max(fetch_ceiling // len(categories) + 1 if fetch_ceiling else 5000, 10)
        for category in categories:
            response = feedback_table.query(
                IndexName='gsi2-by-category',
                KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
                Limit=per_cat,
                ScanIndexForward=False,
            )
            items.extend(response.get('Items', []))
        cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
        items = [i for i in items if i.get('date', '') >= cutoff_date]
    else:
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=per_day_limit,
                ScanIndexForward=False,
            )
            items.extend(response.get('Items', []))
            if not has_post_filters and fetch_ceiling and len(items) >= fetch_ceiling:
                break

    if sources:
        items = [i for i in items if i.get('source_platform') in sources]
    if sentiments:
        items = [i for i in items if i.get('sentiment_label') in sentiments]
    if categories and sources:
        items = [i for i in items if i.get('category') in categories]

    return items


def query_feedback_by_date(
    feedback_table,
    days: int = 30,
    sources: list[str] | None = None,
    categories: list[str] | None = None,
    sentiments: list[str] | None = None,
    limit: int = 500,
    offset: int = 0,
    per_day_limit: int = 500,
) -> list[dict]:
    """Query feedback items by date range with optional filters.

    This is the single source of truth for date-based feedback queries.
    All handlers should use this instead of reimplementing the date loop.

    Args:
        feedback_table: DynamoDB Table resource for feedback.
        days: Number of days to look back from today.
        sources: Optional list of source_platform values to keep.
        categories: Optional list of category values to keep.
            When set *without* sources, queries GSI2 by category instead.
        sentiments: Optional list of sentiment_label values to keep.
        limit: Maximum number of items to return after filtering.
        offset: Number of items to skip (for pagination).
        per_day_limit: DynamoDB Limit per date query (default 500).

    Returns:
        Filtered list of feedback items, sliced by offset/limit.
    """
    if not feedback_table:
        logger.warning("No feedback table provided, returning empty list")
        return []

    target = offset + limit
    items = _fetch_and_filter(
        feedback_table,
        days=min(days, MAX_LOOKBACK_DAYS),
        sources=sources or [],
        categories=categories or [],
        sentiments=sentiments or [],
        fetch_ceiling=target * 3,
        per_day_limit=per_day_limit,
    )
    return items[offset:offset + limit]


def query_feedback_page(
    feedback_table,
    days: int = 30,
    sources: list[str] | None = None,
    categories: list[str] | None = None,
    sentiments: list[str] | None = None,
    limit: int = 100,
    offset: int = 0,
    per_day_limit: int = 500,
) -> tuple[list[dict], int]:
    """Query a page of feedback items and return the total count.

    Same as :func:`query_feedback_by_date` but scans all matching dates
    to return an accurate total count for pagination.

    Returns:
        Tuple of (page_items, total_count).
    """
    if not feedback_table:
        return [], 0

    # fetch_ceiling=0 disables early break so we get the true total
    items = _fetch_and_filter(
        feedback_table,
        days=min(days, MAX_LOOKBACK_DAYS),
        sources=sources or [],
        categories=categories or [],
        sentiments=sentiments or [],
        fetch_ceiling=0,
        per_day_limit=per_day_limit,
    )
    total = len(items)
    page = items[offset:offset + limit]
    return page, total


def get_feedback_context(feedback_table, filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context.

    Thin wrapper around :func:`query_feedback_by_date` that unpacks a
    filters dict.  Kept for backward compatibility with callers that pass
    a dict (research handler, projects API, persona generator).

    Args:
        feedback_table: DynamoDB Table resource for feedback
        filters: Dict with keys: days, categories, sentiments, sources
        limit: Maximum number of items to return

    Returns:
        List of feedback items matching filters
    """
    return query_feedback_by_date(
        feedback_table,
        days=filters.get('days', 30),
        sources=filters.get('sources'),
        categories=filters.get('categories'),
        sentiments=filters.get('sentiments'),
        limit=limit,
    )
def format_feedback_for_llm(items: list[dict]) -> str:
    """Format feedback items for LLM context with rich details.
    
    Args:
        items: List of feedback items from DynamoDB
        
    Returns:
        Formatted string for LLM context
    """
    lines = []
    for i, item in enumerate(items, 1):
        # Build optional fields
        quote = item.get('direct_customer_quote', '')
        root_cause = item.get('problem_root_cause_hypothesis', '')
        persona_type = item.get('persona_type', '')
        journey_stage = item.get('journey_stage', '')
        
        lines.append(f"""
### Review {i}
- Source: {item.get('source_platform', 'unknown')}
- Date: {item.get('source_created_at', '')[:10] if item.get('source_created_at') else 'N/A'}
- Sentiment: {item.get('sentiment_label', 'unknown')} (score: {float(item.get('sentiment_score', 0)):.2f})
- Category: {item.get('category', 'other')}
- Rating: {item.get('rating', 'N/A')}/5
- Urgency: {item.get('urgency', 'low')}
- Customer Type: {persona_type if persona_type else 'unknown'}
- Journey Stage: {journey_stage if journey_stage else 'unknown'}
- Full Text: "{item.get('original_text', '')[:600]}"
{f'- Key Quote: "{quote}"' if quote else ''}
{f'- Problem Summary: {item.get("problem_summary", "")}' if item.get('problem_summary') else ''}
{f'- Root Cause Hypothesis: {root_cause}' if root_cause else ''}
""")
    return '\n'.join(lines)
def get_feedback_statistics(items: list[dict]) -> str:
    """Generate summary statistics from feedback items.
    
    Args:
        items: List of feedback items from DynamoDB
        
    Returns:
        Formatted statistics string for LLM context
    """
    if not items:
        return "No feedback data available."
    
    # Count by sentiment
    sentiments = {}
    categories = {}
    sources = {}
    urgency_counts = {'high': 0, 'medium': 0, 'low': 0}
    ratings = []
    
    for item in items:
        sent = item.get('sentiment_label', 'unknown')
        sentiments[sent] = sentiments.get(sent, 0) + 1
        
        cat = item.get('category', 'other')
        categories[cat] = categories.get(cat, 0) + 1
        
        src = item.get('source_platform', 'unknown')
        sources[src] = sources.get(src, 0) + 1
        
        urg = item.get('urgency', 'low')
        if urg in urgency_counts:
            urgency_counts[urg] += 1
        
        if item.get('rating'):
            ratings.append(float(item['rating']))
    
    avg_rating = sum(ratings) / len(ratings) if ratings else 0
    
    stats = f"""## Feedback Statistics (n={len(items)})

**Sentiment Distribution:**
{chr(10).join([f"- {k}: {v} ({v/len(items)*100:.1f}%)" for k, v in sorted(sentiments.items(), key=lambda x: x[1], reverse=True)])}

**Top Categories:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(categories.items(), key=lambda x: x[1], reverse=True)[:5]])}

**Sources:**
{chr(10).join([f"- {k}: {v}" for k, v in sorted(sources.items(), key=lambda x: x[1], reverse=True)])}

**Urgency Levels:**
- High: {urgency_counts['high']} | Medium: {urgency_counts['medium']} | Low: {urgency_counts['low']}

**Average Rating:** {avg_rating:.1f}/5 (from {len(ratings)} rated reviews)
"""
    return stats
