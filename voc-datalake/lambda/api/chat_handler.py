"""
Chat API Lambda - Handles /chat/*
Manages AI chat conversations.
"""

import os
from datetime import datetime, timezone, timedelta
from typing import Any

from shared.logging import logger, tracer
from shared.aws import get_dynamodb_resource
from shared.api import create_api_resolver, api_handler, validate_days, get_configured_categories
from shared.exceptions import ConfigurationError, NotFoundError
from shared.tables import get_feedback_table, get_aggregates_table, get_conversations_table
from boto3.dynamodb.conditions import Key

dynamodb = get_dynamodb_resource()
feedback_table = get_feedback_table()
aggregates_table = get_aggregates_table()
conversations_table = get_conversations_table()

app = create_api_resolver()


# ============================================
# Chat Endpoint
# ============================================

@tracer.capture_method
def _batch_get_aggregates(keys: list[dict]) -> list[dict]:
    """
    Fetch multiple aggregate items using batch_get_item (up to 100 keys per call).
    
    Returns all items found across all batches.
    """
    if not keys:
        return []
    
    table_name = os.environ.get('AGGREGATES_TABLE', '')
    all_items = []
    
    # batch_get_item supports max 100 keys per call
    for batch_start in range(0, len(keys), 100):
        batch_keys = keys[batch_start:batch_start + 100]
        
        response = dynamodb.batch_get_item(
            RequestItems={
                table_name: {
                    'Keys': batch_keys,
                    'ProjectionExpression': 'pk, sk, #c',
                    'ExpressionAttributeNames': {'#c': 'count'},
                }
            }
        )
        
        all_items.extend(response.get('Responses', {}).get(table_name, []))
        
        # Handle unprocessed keys (throttling)
        unprocessed = response.get('UnprocessedKeys', {}).get(table_name, {}).get('Keys', [])
        while unprocessed:
            retry_response = dynamodb.batch_get_item(
                RequestItems={
                    table_name: {
                        'Keys': unprocessed,
                        'ProjectionExpression': 'pk, sk, #c',
                        'ExpressionAttributeNames': {'#c': 'count'},
                    }
                }
            )
            all_items.extend(retry_response.get('Responses', {}).get(table_name, []))
            unprocessed = retry_response.get('UnprocessedKeys', {}).get(table_name, {}).get('Keys', [])
    
    return all_items


@app.post("/chat")
@tracer.capture_method
def chat():
    """AI chat endpoint for querying feedback data using Bedrock."""
    body = app.current_event.json_body
    message = body.get('message', '')
    
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=7)
    
    current_date = datetime.now(timezone.utc)
    dates = [(current_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(days)]
    categories = get_configured_categories(aggregates_table)
    sentiments = ['positive', 'negative', 'neutral', 'mixed']
    
    # Build all keys upfront and fetch in batches instead of N+1 individual calls
    all_keys = []
    for date in dates:
        all_keys.append({'pk': 'METRIC#daily_total', 'sk': date})
        all_keys.append({'pk': 'METRIC#urgent', 'sk': date})
        for s in sentiments:
            all_keys.append({'pk': f'METRIC#daily_sentiment#{s}', 'sk': date})
        for cat in categories:
            all_keys.append({'pk': f'METRIC#daily_category#{cat}', 'sk': date})
    
    # Single batched fetch replaces hundreds of individual get_item calls
    items = _batch_get_aggregates(all_keys)
    
    # Index results by (pk, sk) for O(1) lookup
    items_by_key = {(item['pk'], item['sk']): item for item in items}
    
    # Tally totals from batch results
    total_feedback = sum(
        items_by_key.get(('METRIC#daily_total', d), {}).get('count', 0) for d in dates
    )
    
    sentiment_counts = {
        s: sum(items_by_key.get((f'METRIC#daily_sentiment#{s}', d), {}).get('count', 0) for d in dates)
        for s in sentiments
    }
    
    category_counts = {}
    for cat in categories:
        total = sum(items_by_key.get((f'METRIC#daily_category#{cat}', d), {}).get('count', 0) for d in dates)
        if total > 0:
            category_counts[cat] = total
    
    urgent_count = sum(
        items_by_key.get(('METRIC#urgent', d), {}).get('count', 0) for d in dates
    )
    
    # Get recent feedback
    feedback_items = []
    for i in range(min(days, 7)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
            Limit=10,
            ScanIndexForward=False
        )
        feedback_items.extend(response.get('Items', []))
        if len(feedback_items) >= 30:
            break
    
    # Build context
    feedback_context = []
    for item in feedback_items[:20]:
        feedback_context.append({
            'source': item.get('source_platform', 'unknown'),
            'date': item.get('source_created_at', '')[:10] if item.get('source_created_at') else '',
            'text': item.get('original_text', '')[:500],
            'sentiment': item.get('sentiment_label', 'unknown'),
            'sentiment_score': float(item.get('sentiment_score', 0)),
            'category': item.get('category', 'other'),
            'urgency': item.get('urgency', 'low'),
            'rating': item.get('rating'),
            'problem_summary': item.get('problem_summary', ''),
        })
    
    system_prompt = """You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.
When answering questions:
1. Base your answers ONLY on the actual data provided
2. Be specific with numbers and percentages
3. Quote actual customer feedback when relevant
4. Highlight urgent issues
5. Provide actionable recommendations"""

    # Inject language instruction if non-English
    response_language = body.get('response_language')
    if response_language:
        from shared.prompts import get_response_language_instruction
        lang_instruction = get_response_language_instruction(response_language)
        if lang_instruction:
            system_prompt += f"\n\n{lang_instruction}"

    data_context = f"""## Data Summary (Last {days} days)
Total Feedback: {total_feedback}
Urgent Issues: {urgent_count}

Sentiment: Positive {sentiment_counts['positive']}, Neutral {sentiment_counts['neutral']}, Negative {sentiment_counts['negative']}, Mixed {sentiment_counts['mixed']}

Top Categories: {', '.join([f"{cat}: {count}" for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:5]])}

## Recent Feedback:
"""
    for i, fb in enumerate(feedback_context[:10], 1):
        data_context += f"\n{i}. [{fb['source']}|{fb['sentiment']}] {fb['text'][:200]}"

    try:
        from shared.converse import converse
        response_text = converse(
            prompt=f"{data_context}\n\nQuestion: {message}",
            system_prompt=system_prompt,
            max_tokens=1500,
        )
        
        return {
            'response': response_text,
            'sources': feedback_items[:3],
            'metadata': {'total_feedback': total_feedback, 'days_analyzed': days, 'urgent_count': urgent_count}
        }
    except Exception as e:
        logger.exception(f"Bedrock call failed: {e}")
        return {
            'response': f"Error connecting to AI service. Summary: {total_feedback} feedback items, {urgent_count} urgent.",
            'sources': feedback_items[:3],
            'error': 'AI service temporarily unavailable'
        }


# ============================================
# Chat Conversations Endpoints
# ============================================

@app.get("/chat/conversations/<proxy+>")
@tracer.capture_method
def get_conversations(proxy: str = ""):
    """List or get chat conversations."""
    if not conversations_table:
        return {'conversations': []}
    
    conversation_id = proxy.strip() if proxy and proxy != '_list' else None
    
    if conversation_id:
        try:
            response = conversations_table.get_item(Key={'pk': 'USER#default', 'sk': f'CONV#{conversation_id}'})
            item = response.get('Item')
            if not item:
                raise NotFoundError(f"Conversation {conversation_id} not found")
            return {
                'id': item.get('conversation_id'),
                'title': item.get('title', 'New Conversation'),
                'messages': item.get('messages', []),
                'filters': item.get('filters', {}),
                'createdAt': item.get('created_at'),
                'updatedAt': item.get('updated_at'),
            }
        except NotFoundError:
            raise
    
    response = conversations_table.query(
        KeyConditionExpression=Key('pk').eq('USER#default'),
        ScanIndexForward=False,
        Limit=50
    )
    
    conversations = []
    for item in response.get('Items', []):
        conversations.append({
            'id': item.get('conversation_id'),
            'title': item.get('title', 'New Conversation'),
            'messageCount': len(item.get('messages', [])),
            'createdAt': item.get('created_at'),
            'updatedAt': item.get('updated_at'),
        })
    
    return {'conversations': conversations}


@app.post("/chat/conversations/<proxy+>")
@tracer.capture_method
def save_conversation(proxy: str = ""):
    """Save a chat conversation."""
    if not conversations_table:
        raise ConfigurationError('Conversations not configured')
    
    body = app.current_event.json_body
    conversation_id = body.get('id') or f"conv-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    
    item = {
        'pk': 'USER#default',
        'sk': f'CONV#{conversation_id}',
        'conversation_id': conversation_id,
        'title': body.get('title', 'New Conversation'),
        'messages': body.get('messages', []),
        'filters': body.get('filters', {}),
        'created_at': body.get('createdAt') or datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }
    
    conversations_table.put_item(Item=item)
    return {'success': True, 'id': conversation_id}


@app.delete("/chat/conversations/<proxy+>")
@tracer.capture_method
def delete_conversation(proxy: str):
    """Delete a chat conversation."""
    if not conversations_table:
        raise ConfigurationError('Conversations table not configured')
    if not proxy:
        raise NotFoundError('Conversation ID is required')
    
    conversations_table.delete_item(Key={'pk': 'USER#default', 'sk': f'CONV#{proxy}'})
    return {'success': True}



# ============================================
# Lambda Handler
# ============================================

@api_handler
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
