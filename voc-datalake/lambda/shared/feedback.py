"""
Shared feedback utilities for LLM context building.
Used by projects API and research step handler.
"""

from datetime import datetime, timezone, timedelta
from boto3.dynamodb.conditions import Key

from shared.logging import logger


def get_feedback_context(feedback_table, filters: dict, limit: int = 50) -> list[dict]:
    """Get feedback items based on filters for LLM context.
    
    Args:
        feedback_table: DynamoDB Table resource for feedback
        filters: Dict with keys: days, categories, sentiments, sources
        limit: Maximum number of items to return
        
    Returns:
        List of feedback items matching filters
    """
    if not feedback_table:
        return []
    
    days = filters.get('days', 30)
    categories = filters.get('categories', [])
    sentiments = filters.get('sentiments', [])
    sources = filters.get('sources', [])
    
    items = []
    current_date = datetime.now(timezone.utc)
    
    # Query by date or category, then filter by source_platform in memory
    # This ensures consistent filtering with metrics aggregation
    if categories and not sources:
        # If only categories are selected, query each category
        for category in categories:
            response = feedback_table.query(
                IndexName='gsi2-by-category',
                KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
                Limit=limit // len(categories) + 1,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
    else:
        # Query by date
        for i in range(min(days, 30)):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit * 3:
                break
    
    # Apply source filter using source_platform field
    if sources:
        items = [i for i in items if i.get('source_platform') in sources]
    
    # Apply sentiment filter
    if sentiments:
        items = [i for i in items if i.get('sentiment_label') in sentiments]
    
    # Apply category filter if we queried by date
    if categories and sources:
        items = [i for i in items if i.get('category') in categories]
    
    return items[:limit]


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
- Sentiment: {item.get('sentiment_label', 'unknown')} (score: {item.get('sentiment_score', 0):.2f})
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
