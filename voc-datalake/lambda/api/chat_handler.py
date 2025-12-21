"""
Chat API Lambda - Handles /chat/*
Manages AI chat conversations.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

# Add shared module to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig
from aws_lambda_powertools.event_handler.exceptions import NotFoundError
from boto3.dynamodb.conditions import Key

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
AGGREGATES_TABLE = os.environ.get("AGGREGATES_TABLE", "")
CONVERSATIONS_TABLE = os.environ.get("CONVERSATIONS_TABLE", "")

feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None
conversations_table = dynamodb.Table(CONVERSATIONS_TABLE) if CONVERSATIONS_TABLE else None

# Configure CORS - restrict to CloudFront domain in production
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
cors_config = CORSConfig(
    allow_origin=ALLOWED_ORIGIN,
    allow_headers=[
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "X-Amz-Date",
        "X-Api-Key",
        "X-Amz-Security-Token",
    ],
    expose_headers=["Content-Type"],
    max_age=300,
    allow_credentials=False,
)

app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def validate_days(value: str | int | None, default: int = 7, min_val: int = 1, max_val: int = 365) -> int:
    """Validate and bound days parameter."""
    try:
        days = int(value) if value is not None else default
        return max(min_val, min(days, max_val))
    except (ValueError, TypeError):
        return default


# ============================================
# Chat Endpoint
# ============================================

@app.post("/chat")
@tracer.capture_method
def chat():
    """AI chat endpoint for querying feedback data using Bedrock."""
    body = app.current_event.json_body
    message = body.get('message', '')
    
    params = app.current_event.query_string_parameters or {}
    days = validate_days(params.get('days'), default=7)
    
    current_date = datetime.now(timezone.utc)
    
    # Get metrics
    total_feedback = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
        item = response.get('Item')
        if item:
            total_feedback += item.get('count', 0)
    
    sentiment_counts = {'positive': 0, 'negative': 0, 'neutral': 0, 'mixed': 0}
    for sentiment in sentiment_counts.keys():
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date})
            item = response.get('Item')
            if item:
                sentiment_counts[sentiment] += item.get('count', 0)
    
    category_counts = {}
    categories = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                  'website', 'app', 'billing', 'returns', 'communication', 'other']
    for category in categories:
        total = 0
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
            item = response.get('Item')
            if item:
                total += item.get('count', 0)
        if total > 0:
            category_counts[category] = total
    
    urgent_count = 0
    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        response = aggregates_table.get_item(Key={'pk': 'METRIC#urgent', 'sk': date})
        item = response.get('Item')
        if item:
            urgent_count += item.get('count', 0)
    
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
        bedrock = get_bedrock_client()
        bedrock_response = bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1500,
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': f"{data_context}\n\nQuestion: {message}"}]
            })
        )
        result = json.loads(bedrock_response['body'].read())
        response_text = result['content'][0]['text']
        
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
        return {'success': False, 'message': 'Conversations not configured'}
    
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
    if not conversations_table or not proxy:
        return {'success': False}
    
    conversations_table.delete_item(Key={'pk': 'USER#default', 'sk': f'CONV#{proxy}'})
    return {'success': True}



# ============================================
# Lambda Handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """Main Lambda handler."""
    return app.resolve(event, context)
