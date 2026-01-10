"""
Streaming chat handler for project AI chat and VoC AI Chat.
Uses Lambda Response Streaming to avoid API Gateway 29s timeout.
"""
import json
import os
import re
from datetime import datetime, timezone, timedelta
from boto3.dynamodb.conditions import Key

# Shared module imports
from shared.logging import logger
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID
from shared.auth import validate_auth, unauthorized_response
from shared.api import (
    validate_days, get_configured_categories, sum_daily_metric,
    api_handler, json_response, error_response
)
from shared.converse import get_search_feedback_tool
from shared.project_chat import build_chat_context

# AWS Clients
dynamodb = get_dynamodb_resource()
bedrock = get_bedrock_client()

# Environment configuration
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

# Table resources
projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

# Sentiment labels constant
SENTIMENT_LABELS = ('positive', 'negative', 'neutral', 'mixed')


# ============================================
# Project Chat Handler
# ============================================

def project_chat_handler(event, context):
    """Handler for project chat via Function URL."""
    try:
        body = json.loads(event.get('body', '{}'))
        
        # Extract project_id from path
        path = event.get('rawPath', '') or event.get('requestContext', {}).get('http', {}).get('path', '')
        parts = path.strip('/').split('/')
        project_id = None
        for i, part in enumerate(parts):
            if part == 'projects' and i + 1 < len(parts):
                project_id = parts[i + 1]
                break
        
        if not project_id:
            return error_response('Project ID required', 400)
        
        message = body.get('message', '')
        system_prompt, user_message, metadata = build_chat_context(
            projects_table,
            feedback_table,
            project_id,
            message,
            selected_persona_ids=body.get('selected_personas', []),
            selected_document_ids=body.get('selected_documents', []),
        )
        
        if system_prompt is None:
            return error_response(metadata.get('error', 'Project not found'), 404)
        
        # Call Bedrock with streaming
        response = bedrock.invoke_model_with_response_stream(
            modelId=BEDROCK_MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 3000,
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': user_message}]
            })
        )
        
        # Collect streamed response
        full_response = ""
        for event_chunk in response.get('body', []):
            chunk = json.loads(event_chunk.get('chunk', {}).get('bytes', b'{}'))
            if chunk.get('type') == 'content_block_delta':
                delta = chunk.get('delta', {})
                if delta.get('type') == 'text_delta':
                    full_response += delta.get('text', '')
        
        return json_response({
            'success': True,
            'response': full_response,
            **metadata
        })
        
    except Exception as e:
        logger.exception(f"Project chat error: {e}")
        return error_response('An internal error occurred. Please try again.', 500)


# ============================================
# VoC AI Chat Helpers
# ============================================

def parse_context_filters(context_hint: str) -> dict:
    """Parse filter values from context hint string."""
    if not context_hint:
        return {}
    
    filters = {}
    patterns = {
        'source': r'Source:\s*([^.]+)',
        'category': r'Category:\s*([^.]+)',
        'sentiment': r'Sentiment:\s*([^.]+)',
    }
    
    for key, pattern in patterns.items():
        match = re.search(pattern, context_hint)
        if match:
            filters[key] = match.group(1).strip()
    
    return filters


def get_aggregated_metrics(days: int) -> dict:
    """Get high-level metrics from aggregates table."""
    if not aggregates_table:
        return {'total': 0, 'sentiment': {}, 'categories': {}, 'urgent': 0}
    
    current_date = datetime.now(timezone.utc)
    
    # Get totals using shared helper
    total_feedback = sum_daily_metric(aggregates_table, 'METRIC#daily_total', days, current_date)
    urgent_count = sum_daily_metric(aggregates_table, 'METRIC#urgent', days, current_date)
    
    # Get sentiment breakdown
    sentiment_counts = {
        label: sum_daily_metric(aggregates_table, f'METRIC#daily_sentiment#{label}', days, current_date)
        for label in SENTIMENT_LABELS
    }
    
    # Get category breakdown
    categories = get_configured_categories(aggregates_table)
    category_counts = {}
    for category in categories:
        total = sum_daily_metric(aggregates_table, f'METRIC#daily_category#{category}', days, current_date)
        if total > 0:
            category_counts[category] = total
    
    return {
        'total': total_feedback,
        'sentiment': sentiment_counts,
        'categories': category_counts,
        'urgent': urgent_count
    }


def get_voc_chat_context(body: dict) -> tuple[str, str, dict]:
    """Build context for VoC AI Chat (main chat page) - tool-based approach."""
    message = body.get('message', '')
    context_hint = body.get('context', '')
    days = validate_days(body.get('days'), default=7)
    
    parsed_filters = parse_context_filters(context_hint)
    source_filter = parsed_filters.get('source')
    category_filter = parsed_filters.get('category')
    sentiment_filter = parsed_filters.get('sentiment')
    
    metrics_data = get_aggregated_metrics(days)
    total_feedback = metrics_data['total']
    sentiment_counts = metrics_data['sentiment']
    category_counts = metrics_data['categories']
    urgent_count = metrics_data['urgent']
    
    system_prompt = """You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.

You have access to a tool called "search_feedback" that lets you search and retrieve customer feedback from various sources (Trustpilot, Google Reviews, Twitter, Instagram, Facebook, Reddit, app stores, etc.).

IMPORTANT GUIDELINES:
1. ONLY use the search_feedback tool when the user's question is specifically about customer feedback, reviews, or customer opinions
2. For general questions, greetings, or non-feedback topics, respond directly WITHOUT using the tool
3. When you DO use the tool, be specific with your search query to get relevant results
4. Base your answers on the actual data returned by the tool
5. Quote actual customer feedback when relevant
6. Highlight urgent issues that need attention
7. Provide actionable recommendations based on the data

Format your responses clearly with bullet points or numbered lists when appropriate."""

    # Build data context with metrics summary
    top_categories = sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    data_context = f"""## Current Data Summary (Last {days} days)

**Total Feedback Items:** {total_feedback}
**Urgent Issues:** {urgent_count}

**Sentiment Breakdown:**
- Positive: {sentiment_counts['positive']} ({round(sentiment_counts['positive']/max(total_feedback,1)*100, 1)}%)
- Neutral: {sentiment_counts['neutral']} ({round(sentiment_counts['neutral']/max(total_feedback,1)*100, 1)}%)
- Negative: {sentiment_counts['negative']} ({round(sentiment_counts['negative']/max(total_feedback,1)*100, 1)}%)
- Mixed: {sentiment_counts['mixed']} ({round(sentiment_counts['mixed']/max(total_feedback,1)*100, 1)}%)

**Top Categories:**
{'\n'.join([f"- {cat}: {count}" for cat, count in top_categories])}
"""

    # Show active filters if any
    active_filters = []
    if source_filter:
        active_filters.append(f"Source: {source_filter}")
    if category_filter:
        active_filters.append(f"Category: {category_filter}")
    if sentiment_filter:
        active_filters.append(f"Sentiment: {sentiment_filter}")
    
    if active_filters:
        data_context += f"\n## Active Filters: {', '.join(active_filters)}\nWhen using the search_feedback tool, apply these filters.\n"

    user_message = f"{data_context}\n\n---\n\nUser Question: {message}"
    
    metadata = {
        'total_feedback': total_feedback,
        'days_analyzed': days,
        'urgent_count': urgent_count,
        'filters': {
            'source': source_filter,
            'category': category_filter,
            'sentiment': sentiment_filter,
            'days': days
        }
    }
    
    return system_prompt, user_message, metadata


# ============================================
# Tool Execution for VoC Chat
# ============================================

def matches_feedback_item(item: dict, query: str, filters: dict, cutoff_date: str) -> bool:
    """Check if a feedback item matches the search criteria."""
    if item.get('date', '') < cutoff_date:
        return False
    if filters.get('source') and item.get('source_platform') != filters['source']:
        return False
    if filters.get('sentiment') and item.get('sentiment_label') != filters['sentiment']:
        return False
    if filters.get('category') and item.get('category') != filters['category']:
        return False
    if filters.get('urgency') and item.get('urgency') != filters['urgency']:
        return False
    
    if query:
        query_lower = query.lower()
        original_text = (item.get('original_text') or '').lower()
        title = (item.get('title') or '').lower()
        problem_summary = (item.get('problem_summary') or '').lower()
        if query_lower not in original_text and query_lower not in title and query_lower not in problem_summary:
            return False
    
    return True


def execute_search_feedback_tool(tool_input: dict, context_filters: dict) -> list:
    """Execute the search_feedback tool and return results."""
    query = tool_input.get('query', '')
    limit = min(tool_input.get('limit', 15), 30)
    days = context_filters.get('days', 30)
    
    # Merge tool input filters with context filters (tool input takes precedence)
    filters = {
        'source': tool_input.get('source') or context_filters.get('source'),
        'category': tool_input.get('category') or context_filters.get('category'),
        'sentiment': tool_input.get('sentiment') or context_filters.get('sentiment'),
        'urgency': tool_input.get('urgency'),
    }
    
    if not feedback_table:
        return []
    
    # Check if query looks like a feedback ID
    if query and re.match(r'^[a-f0-9]{32}$', query.lower().strip()):
        try:
            response = feedback_table.query(
                IndexName='gsi4-by-feedback-id',
                KeyConditionExpression=Key('feedback_id').eq(query.lower().strip()),
                Limit=1
            )
            items = response.get('Items', [])
            if items:
                logger.info(f"Found feedback by ID: {query}")
                return items
        except Exception as e:
            logger.warning(f"Failed to query by feedback_id: {e}")
    
    current_date = datetime.now(timezone.utc)
    cutoff_date = (current_date - timedelta(days=days)).strftime('%Y-%m-%d')
    
    # Query recent feedback by date
    candidates = []
    for i in range(min(days, 30)):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
        try:
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=300,
                ScanIndexForward=False
            )
            candidates.extend(response.get('Items', []))
            if len(candidates) >= 1000:
                break
        except Exception:
            pass
    
    # Filter candidates
    items = [
        item for item in candidates
        if matches_feedback_item(item, query, filters, cutoff_date)
    ][:limit]
    
    return items


def format_tool_results(items: list) -> str:
    """Format feedback items as tool result for LLM."""
    if not items:
        return "No feedback found matching the search criteria."
    
    result = f"Found {len(items)} relevant feedback items:\n\n"
    
    for i, item in enumerate(items, 1):
        source_date = item.get('source_created_at', '')[:10] if item.get('source_created_at') else 'N/A'
        problem_line = f"- Problem Summary: {item.get('problem_summary')}" if item.get('problem_summary') else ''
        result += f"""### Feedback #{i}
- Source: {item.get('source_platform', 'unknown')}
- Date: {source_date}
- Sentiment: {item.get('sentiment_label', 'unknown')} ({float(item.get('sentiment_score', 0)):.2f})
- Category: {item.get('category', 'other')}
- Rating: {item.get('rating') if item.get('rating') else 'N/A'}
- Text: "{item.get('original_text', '')[:400]}"
{problem_line}

"""
    return result


def process_tool_uses(content_blocks: list, filters: dict, sources: list) -> list:
    """Process all toolUse blocks and return toolResult blocks."""
    tool_results = []
    existing_ids = {s.get('feedback_id') for s in sources}
    
    for block in content_blocks:
        if 'toolUse' not in block:
            continue
            
        tool_use = block['toolUse']
        tool_name = tool_use.get('name')
        tool_use_id = tool_use.get('toolUseId')
        tool_input = tool_use.get('input', {})
        
        if tool_name == 'search_feedback':
            logger.info(f"Executing search_feedback tool: {tool_input}")
            feedback_items = execute_search_feedback_tool(tool_input, filters)
            result_content = format_tool_results(feedback_items)
            
            for item in feedback_items[:5]:
                if item.get('feedback_id') not in existing_ids:
                    sources.append(item)
                    existing_ids.add(item.get('feedback_id'))
        else:
            logger.warning(f"Unknown tool requested: {tool_name}")
            result_content = f"Error: Unknown tool '{tool_name}'"
        
        tool_results.append({
            'toolResult': {
                'toolUseId': tool_use_id,
                'content': [{'text': result_content}]
            }
        })
    
    return tool_results


def extract_text_response(content_blocks: list) -> str:
    """Extract text content from Converse API response blocks."""
    return ''.join(block.get('text', '') for block in content_blocks if 'text' in block)


# ============================================
# VoC Chat Handler
# ============================================

def voc_chat_handler(event, context):
    """Handler for VoC AI Chat via Function URL with tool use."""
    try:
        body = json.loads(event.get('body', '{}') or '{}')
        
        message = body.get('message', '')
        if not message:
            return error_response('Message is required', 400)
        
        system_prompt, user_message, metadata = get_voc_chat_context(body)
        filters = metadata.get('filters', {})
        
        messages = [{'role': 'user', 'content': [{'text': user_message}]}]
        sources = []
        tool_config = {'tools': [get_search_feedback_tool()]}
        
        # Agentic loop - max 4 iterations
        max_iterations = 4
        full_response = ""
        
        for iteration in range(max_iterations):
            logger.info(f"Converse iteration {iteration + 1}")
            
            response = bedrock.converse(
                modelId=BEDROCK_MODEL_ID,
                system=[{'text': system_prompt}],
                messages=messages,
                toolConfig=tool_config,
                inferenceConfig={'maxTokens': 2000}
            )
            
            output = response.get('output', {})
            content_blocks = output.get('message', {}).get('content', [])
            
            if response.get('stopReason') == 'tool_use':
                tool_results = process_tool_uses(content_blocks, filters, sources)
                
                if not tool_results:
                    full_response = extract_text_response(content_blocks)
                    break
                
                messages.append({'role': 'assistant', 'content': content_blocks})
                messages.append({'role': 'user', 'content': tool_results})
            else:
                full_response = extract_text_response(content_blocks)
                break
        else:
            logger.warning("Max tool use iterations reached")
            full_response = "I found some relevant feedback but couldn't complete the full analysis. Please try a more specific question."
        
        return json_response({
            'response': full_response,
            'sources': sources,
            'metadata': {
                'total_feedback': metadata.get('total_feedback', 0),
                'days_analyzed': metadata.get('days_analyzed', 7),
                'urgent_count': metadata.get('urgent_count', 0),
                'tool_used': len(sources) > 0
            }
        })
        
    except Exception as e:
        logger.exception(f"VoC chat error: {e}")
        return error_response('An internal error occurred. Please try again.', 500)


# ============================================
# Combined Handler (Entry Point)
# ============================================

@api_handler
def combined_handler(event, context):
    """Combined handler that routes based on path."""
    # Validate authentication first
    is_valid, error_msg = validate_auth(event)
    if not is_valid:
        logger.warning(f"Authentication failed: {error_msg}")
        return unauthorized_response(error_msg)
    
    # Get path from Lambda Function URL event
    path = (
        event.get('rawPath', '') or 
        event.get('requestContext', {}).get('http', {}).get('path', '') or
        event.get('path', '')
    )
    
    logger.info(f"Chat stream request - path: {path}")
    
    # Route based on path
    if '/projects/' in path:
        logger.info("Routing to project chat handler")
        return project_chat_handler(event, context)
    else:
        # Default to VoC chat for /chat/stream or any other path
        logger.info("Routing to VoC chat handler")
        return voc_chat_handler(event, context)


# Lambda handler entry point
lambda_handler = combined_handler
