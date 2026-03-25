"""
MCP (Model Context Protocol) Server Lambda Handler.

Implements the MCP JSON-RPC protocol over HTTP with Bearer token authentication.
Tokens are validated against hashed tokens stored in DynamoDB (created via the
MCP Access tab in the frontend).

Public endpoint — no Cognito auth. Auth is handled by validating the Bearer token
from the Authorization header against SHA-256 hashes in the projects table.
"""

import json
import os
import hashlib
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

from aws_lambda_powertools import Logger, Tracer, Metrics
from boto3.dynamodb.conditions import Key

from shared.aws import get_dynamodb_resource
from shared.api import DecimalEncoder
from projects import autoseed_project

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-MCP")

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')

projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None

# MCP Protocol version
MCP_PROTOCOL_VERSION = "2024-11-05"

# Token prefix used during generation
TOKEN_PREFIX = 'voc_'


# ============================================
# CORS helpers
# ============================================

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Project-Id',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
}


def _cors_response(body: dict, status_code: int = 200) -> dict:
    """Return a Lambda proxy response with CORS headers."""
    return {
        'statusCode': status_code,
        'headers': {**CORS_HEADERS, 'Content-Type': 'application/json'},
        'body': json.dumps(body, cls=DecimalEncoder),
    }


# ============================================
# Token authentication
# ============================================

def _hash_token(token: str) -> str:
    """Hash a token for comparison with stored hashes."""
    return hashlib.sha256(token.encode()).hexdigest()


@tracer.capture_method
def _authenticate(event: dict) -> dict | None:
    """
    Validate Bearer token from Authorization header.

    Returns the token DynamoDB item (with project_id, scope, etc.) on success,
    or None if authentication fails.
    """
    headers = event.get('headers', {})
    # API Gateway lowercases header names in proxy mode
    auth_header = headers.get('authorization') or headers.get('Authorization') or ''
    project_id = headers.get('x-project-id') or headers.get('X-Project-Id') or ''

    if not auth_header.startswith('Bearer ') or not project_id:
        return None

    raw_token = auth_header[7:]  # strip "Bearer "
    if not raw_token.startswith(TOKEN_PREFIX):
        return None

    token_hash = _hash_token(raw_token)

    if not projects_table:
        logger.error("Projects table not configured")
        return None

    # Query all tokens for this project and find matching hash
    response = projects_table.query(
        KeyConditionExpression=(
            Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('TOKEN#')
        ),
    )

    for item in response.get('Items', []):
        if item.get('token_hash') == token_hash:
            # Update last_used_at
            try:
                projects_table.update_item(
                    Key={'pk': f'PROJECT#{project_id}', 'sk': item['sk']},
                    UpdateExpression='SET last_used_at = :now',
                    ExpressionAttributeValues={':now': datetime.now(timezone.utc).isoformat()},
                )
            except Exception as e:
                logger.warning(f"Failed to update last_used_at: {e}")
            return {**item, 'project_id': project_id}

    return None


# ============================================
# MCP Tool definitions
# ============================================

MCP_TOOLS = [
    {
        "name": "search_feedback",
        "description": (
            "Search customer feedback items with optional filters. "
            "Returns feedback text, sentiment, category, urgency, and metadata."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text to search for in feedback (substring match on original_text)",
                },
                "days": {
                    "type": "integer",
                    "description": "Number of days to look back (default 7, max 30)",
                    "default": 7,
                },
                "category": {
                    "type": "string",
                    "description": "Filter by category (e.g. delivery, pricing, product_quality)",
                },
                "sentiment": {
                    "type": "string",
                    "enum": ["positive", "negative", "neutral", "mixed"],
                    "description": "Filter by sentiment label",
                },
                "source": {
                    "type": "string",
                    "description": "Filter by source platform (e.g. webscraper, feedback-form)",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max items to return (default 20, max 50)",
                    "default": 20,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_metrics_summary",
        "description": (
            "Get dashboard summary metrics: total feedback count, sentiment breakdown, "
            "top categories, and average rating over a time period."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "description": "Number of days to aggregate (default 7, max 30)",
                    "default": 7,
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_project",
        "description": (
            "Get details of the current project including personas, documents (PRDs, PR/FAQs), "
            "and project metadata. The project is determined by the X-Project-Id header."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "list_personas",
        "description": (
            "List all personas for the current project with their demographics, "
            "pain points, goals, and behavioral traits."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "get_feedback_detail",
        "description": "Get a single feedback item by its ID with full details.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "feedback_id": {
                    "type": "string",
                    "description": "The feedback item ID",
                },
            },
            "required": ["feedback_id"],
            "additionalProperties": False,
        },
    },
]


# ============================================
# MCP Tool implementations
# ============================================

@tracer.capture_method
def _tool_search_feedback(args: dict, _token_info: dict) -> list[dict]:
    """Search feedback items with filters."""
    if not feedback_table:
        return [{"type": "text", "text": "Feedback table not configured"}]

    days = min(args.get('days', 7), 30)
    category = args.get('category')
    sentiment = args.get('sentiment')
    source = args.get('source')
    query = args.get('query', '').lower()
    limit = min(args.get('limit', 20), 50)

    items = []
    current_date = datetime.now(timezone.utc)

    if category and not source:
        response = feedback_table.query(
            IndexName='gsi2-by-category',
            KeyConditionExpression=Key('gsi2pk').eq(f'CATEGORY#{category}'),
            Limit=limit * 3,
            ScanIndexForward=False,
        )
        items = response.get('Items', [])
    else:
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            response = feedback_table.query(
                IndexName='gsi1-by-date',
                KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                Limit=500,
                ScanIndexForward=False,
            )
            items.extend(response.get('Items', []))
            if len(items) >= limit * 5:
                break

    # Apply filters
    if source:
        items = [i for i in items if i.get('source_platform') == source]
    if category and source:
        items = [i for i in items if i.get('category') == category]
    if sentiment:
        items = [i for i in items if i.get('sentiment_label') == sentiment]
    if query:
        items = [i for i in items if query in (i.get('original_text', '') or '').lower()]

    items = items[:limit]

    if not items:
        return [{"type": "text", "text": "No feedback items found matching the filters."}]

    results = []
    for item in items:
        results.append({
            "id": item.get('id', ''),
            "source": item.get('source_platform', ''),
            "date": (item.get('source_created_at', '') or '')[:10],
            "sentiment": item.get('sentiment_label', ''),
            "sentiment_score": str(item.get('sentiment_score', '')),
            "category": item.get('category', ''),
            "urgency": item.get('urgency', ''),
            "rating": str(item.get('rating', 'N/A')),
            "persona_type": item.get('persona_type', ''),
            "text": (item.get('original_text', '') or '')[:500],
            "problem_summary": item.get('problem_summary', ''),
        })

    return [{"type": "text", "text": json.dumps(results, indent=2, cls=DecimalEncoder)}]


@tracer.capture_method
def _tool_get_metrics_summary(args: dict, _token_info: dict) -> list[dict]:
    """Get aggregated metrics summary."""
    if not aggregates_table:
        return [{"type": "text", "text": "Aggregates table not configured"}]

    days = min(args.get('days', 7), 30)
    current_date = datetime.now(timezone.utc)

    total = 0
    sentiment_counts: dict[str, int] = {}
    category_counts: dict[str, int] = {}

    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')

        # Daily total
        try:
            resp = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
            item = resp.get('Item')
            if item:
                total += int(item.get('count', 0))
        except Exception:
            pass

        # Sentiment counts
        for sent in ['positive', 'negative', 'neutral', 'mixed']:
            try:
                resp = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sent}', 'sk': date})
                item = resp.get('Item')
                if item:
                    sentiment_counts[sent] = sentiment_counts.get(sent, 0) + int(item.get('count', 0))
            except Exception:
                pass

    # Category breakdown from latest aggregate
    try:
        resp = aggregates_table.query(
            KeyConditionExpression=Key('pk').eq('METRIC#category_breakdown'),
            ScanIndexForward=False,
            Limit=1,
        )
        for item in resp.get('Items', []):
            cats = item.get('categories', {})
            if isinstance(cats, dict):
                category_counts = {k: int(v) for k, v in cats.items()}
    except Exception:
        pass

    summary = {
        "period_days": days,
        "total_feedback": total,
        "sentiment_breakdown": sentiment_counts,
        "top_categories": dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:10]),
    }

    return [{"type": "text", "text": json.dumps(summary, indent=2)}]


@tracer.capture_method
def _tool_get_project(args: dict, token_info: dict) -> list[dict]:
    """Get project details including personas and documents."""
    project_id = token_info['project_id']

    if not projects_table:
        return [{"type": "text", "text": "Projects table not configured"}]

    # Get all items for this project
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
    )
    items = response.get('Items', [])

    project_meta = None
    personas = []
    documents = []

    for item in items:
        sk = item.get('sk', '')
        if sk == 'META':
            project_meta = item
        elif sk.startswith('PERSONA#'):
            personas.append(item)
        elif sk.startswith('PRD#') or sk.startswith('PRFAQ#'):
            documents.append(item)

    if not project_meta:
        return [{"type": "text", "text": f"Project {project_id} not found"}]

    result = {
        "project_id": project_id,
        "name": project_meta.get('name', ''),
        "description": project_meta.get('description', ''),
        "created_at": project_meta.get('created_at', ''),
        "persona_count": len(personas),
        "document_count": len(documents),
        "personas": [
            {"persona_id": p.get('persona_id', ''), "name": p.get('name', ''), "type": p.get('type', '')}
            for p in personas
        ],
        "documents": [
            {"document_id": d.get('document_id', ''), "title": d.get('title', ''), "type": d.get('type', '')}
            for d in documents
        ],
    }

    return [{"type": "text", "text": json.dumps(result, indent=2, cls=DecimalEncoder)}]


@tracer.capture_method
def _tool_list_personas(args: dict, token_info: dict) -> list[dict]:
    """List personas with full details."""
    project_id = token_info['project_id']

    if not projects_table:
        return [{"type": "text", "text": "Projects table not configured"}]

    response = projects_table.query(
        KeyConditionExpression=(
            Key('pk').eq(f'PROJECT#{project_id}') & Key('sk').begins_with('PERSONA#')
        ),
    )
    items = response.get('Items', [])

    if not items:
        return [{"type": "text", "text": "No personas found for this project."}]

    personas = []
    for item in items:
        personas.append({
            "persona_id": item.get('persona_id', ''),
            "name": item.get('name', ''),
            "type": item.get('type', ''),
            "age_range": item.get('age_range', ''),
            "occupation": item.get('occupation', ''),
            "goals": item.get('goals', []),
            "pain_points": item.get('pain_points', []),
            "behaviors": item.get('behaviors', []),
            "quote": item.get('quote', ''),
            "journey_stage": item.get('journey_stage', ''),
        })

    return [{"type": "text", "text": json.dumps(personas, indent=2, cls=DecimalEncoder)}]


@tracer.capture_method
def _tool_get_feedback_detail(args: dict, _token_info: dict) -> list[dict]:
    """Get a single feedback item by ID."""
    feedback_id = args.get('feedback_id', '')
    if not feedback_id:
        return [{"type": "text", "text": "feedback_id is required"}]

    if not feedback_table:
        return [{"type": "text", "text": "Feedback table not configured"}]

    response = feedback_table.query(
        IndexName='gsi4-by-feedback-id',
        KeyConditionExpression=Key('feedback_id').eq(feedback_id),
        Limit=1,
    )
    items = response.get('Items', [])

    if not items:
        return [{"type": "text", "text": f"Feedback item {feedback_id} not found"}]

    item = items[0]
    result = {
        "id": item.get('id', ''),
        "source": item.get('source_platform', ''),
        "date": item.get('source_created_at', ''),
        "sentiment": item.get('sentiment_label', ''),
        "sentiment_score": str(item.get('sentiment_score', '')),
        "category": item.get('category', ''),
        "urgency": item.get('urgency', ''),
        "rating": str(item.get('rating', 'N/A')),
        "persona_type": item.get('persona_type', ''),
        "journey_stage": item.get('journey_stage', ''),
        "text": item.get('original_text', ''),
        "problem_summary": item.get('problem_summary', ''),
        "problem_root_cause": item.get('problem_root_cause_hypothesis', ''),
        "direct_quote": item.get('direct_customer_quote', ''),
        "keywords": item.get('keywords', []),
    }

    return [{"type": "text", "text": json.dumps(result, indent=2, cls=DecimalEncoder)}]


# Tool name → implementation mapping
TOOL_HANDLERS = {
    "search_feedback": _tool_search_feedback,
    "get_metrics_summary": _tool_get_metrics_summary,
    "get_project": _tool_get_project,
    "list_personas": _tool_list_personas,
    "get_feedback_detail": _tool_get_feedback_detail,
}


# ============================================
# MCP JSON-RPC protocol handling
# ============================================

def _jsonrpc_error(req_id: Any, code: int, message: str) -> dict:
    """Build a JSON-RPC error response."""
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def _jsonrpc_result(req_id: Any, result: dict) -> dict:
    """Build a JSON-RPC success response."""
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "result": result,
    }


def _handle_initialize(req_id: Any, _params: dict) -> dict:
    """Handle MCP initialize request."""
    return _jsonrpc_result(req_id, {
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {
            "tools": {"listChanged": False},
        },
        "serverInfo": {
            "name": "voc-datalake",
            "version": "1.0.0",
        },
    })


def _handle_tools_list(req_id: Any, _params: dict) -> dict:
    """Handle MCP tools/list request."""
    return _jsonrpc_result(req_id, {"tools": MCP_TOOLS})


def _handle_tools_call(req_id: Any, params: dict, token_info: dict) -> dict:
    """Handle MCP tools/call request."""
    tool_name = params.get('name', '')
    arguments = params.get('arguments', {})

    # Check scope for write operations (future-proofing)
    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        return _jsonrpc_error(req_id, -32602, f"Unknown tool: {tool_name}")

    try:
        content = handler(arguments, token_info)
        return _jsonrpc_result(req_id, {"content": content, "isError": False})
    except Exception as e:
        logger.exception(f"Tool execution error: {tool_name}")
        return _jsonrpc_result(req_id, {
            "content": [{"type": "text", "text": f"Error: {str(e)}"}],
            "isError": True,
        })


def _handle_ping(req_id: Any, _params: dict) -> dict:
    """Handle MCP ping request."""
    return _jsonrpc_result(req_id, {})


# Method → handler mapping
# initialize and ping don't require auth
MCP_METHODS = {
    "initialize": _handle_initialize,
    "ping": _handle_ping,
    "notifications/initialized": None,  # notification, no response needed
}

# Methods that require authentication
MCP_AUTH_METHODS = {
    "tools/list": _handle_tools_list,
    "tools/call": _handle_tools_call,
}


@tracer.capture_method
def _handle_autoseed(event: dict) -> dict:
    """Handle GET /projects/{id}/autoseed with Bearer token auth."""
    token_info = _authenticate(event)
    if not token_info:
        return _cors_response({'message': 'Unauthorized'}, status_code=401)

    path_params = event.get('pathParameters', {}) or {}
    project_id = path_params.get('project_id', '')

    # Ensure the token's project matches the requested project
    if project_id != token_info.get('project_id'):
        return _cors_response({'message': 'Forbidden: token does not match project'}, status_code=403)

    query_params = event.get('queryStringParameters', {}) or {}
    persona_ids = query_params.get('persona_ids', '').split(',') if query_params.get('persona_ids') else None
    document_ids = query_params.get('document_ids', '').split(',') if query_params.get('document_ids') else None

    try:
        result = autoseed_project(project_id, persona_ids=persona_ids, document_ids=document_ids)
        return _cors_response(result)
    except Exception as e:
        logger.exception(f"Autoseed error for project {project_id}")
        return _cors_response({'message': str(e)}, status_code=500)


# ============================================
# Lambda handler
# ============================================

@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def lambda_handler(event: dict, context: Any) -> dict:
    """MCP server Lambda handler — JSON-RPC over HTTP POST + autoseed GET."""

    # Handle CORS preflight
    http_method = event.get('httpMethod', '')
    if http_method == 'OPTIONS':
        return _cors_response({})

    # Handle GET /mcp/autoseed/{project_id} (public, token auth)
    resource_path = event.get('resource', '')
    if http_method == 'GET' and resource_path == '/mcp/autoseed/{project_id}':
        return _handle_autoseed(event)

    if http_method != 'POST':
        return _cors_response(
            _jsonrpc_error(None, -32600, "Only POST is supported"),
            status_code=405,
        )

    # Parse JSON-RPC request
    try:
        body = json.loads(event.get('body', '{}'))
    except (json.JSONDecodeError, TypeError):
        return _cors_response(
            _jsonrpc_error(None, -32700, "Parse error"),
            status_code=400,
        )

    req_id = body.get('id')
    method = body.get('method', '')
    params = body.get('params', {})

    logger.info(f"MCP request: method={method}, id={req_id}")

    # Handle non-auth methods (initialize, ping)
    if method in MCP_METHODS:
        handler = MCP_METHODS[method]
        if handler is None:
            # Notification — no response needed, but HTTP requires a body
            return _cors_response(_jsonrpc_result(req_id, {}))
        return _cors_response(handler(req_id, params))

    # All other methods require authentication
    if method in MCP_AUTH_METHODS:
        token_info = _authenticate(event)
        if not token_info:
            return _cors_response(
                _jsonrpc_error(req_id, -32001, "Unauthorized: invalid or missing API token"),
                status_code=401,
            )

        handler = MCP_AUTH_METHODS[method]
        if method == 'tools/call':
            result = handler(req_id, params, token_info)
        else:
            result = handler(req_id, params)
        return _cors_response(result)

    # Unknown method
    return _cors_response(
        _jsonrpc_error(req_id, -32601, f"Method not found: {method}"),
    )
