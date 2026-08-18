"""
Web search via the Amazon Bedrock AgentCore Gateway Web Search Tool.

The gateway exposes the AWS-managed `web-search` connector as a standard MCP
tool. This module calls it directly over the gateway's streamable-HTTP MCP
endpoint with a SigV4-signed JSON-RPC `tools/call` request — no MCP SDK or
third-party search API needed, and queries never leave AWS.

Configuration (both set by CDK when the feature is deployed):
    WEB_SEARCH_GATEWAY_URL   e.g. https://gw-x.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp
    WEB_SEARCH_TOOL_NAME     gateway-prefixed MCP tool name (target___tool)

Acceptable use: callers surfacing results to end users MUST retain the
source URLs/titles (see format_web_results_for_llm, which embeds them).
"""

import json
import os
import re
import urllib.request
from urllib.parse import urlparse

import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from shared.logging import logger, tracer

# The web-search connector caps queries at 200 characters.
MAX_QUERY_LENGTH = 200
# The connector allows up to 25 results; keep the default modest for
# context economy ($7 / 1k queries — results size is a token cost, not a
# query cost, but oversized snippets crowd out feedback context).
DEFAULT_MAX_RESULTS = 8
MAX_RESULTS_CAP = 10

_REQUEST_TIMEOUT_SECONDS = 20

# Resolved lazily and cached: the configured name is used as-is, but if the
# gateway reports it unknown (target renamed, prefix convention change), we
# fall back to tools/list discovery — at most once per call.
_resolved_tool_name: dict = {'name': None}

# Module-level credential cache (repo pattern: module-level boto3 state for
# connection/credential reuse). botocore credentials self-refresh, so caching
# the resolved provider is safe across invocations.
_credentials_cache: dict = {'credentials': None}


def _get_credentials():
    if _credentials_cache['credentials'] is None:
        _credentials_cache['credentials'] = boto3.session.Session().get_credentials()
    return _credentials_cache['credentials']


class WebSearchError(Exception):
    """Raised when a web search request fails. Callers should degrade
    gracefully — web search is always an enrichment, never a hard
    dependency."""


def is_web_search_configured() -> bool:
    """True when the AgentCore web search gateway is deployed and wired."""
    return bool(os.environ.get('WEB_SEARCH_GATEWAY_URL', ''))


def _gateway_url() -> str:
    return os.environ.get('WEB_SEARCH_GATEWAY_URL', '')


def _configured_tool_name() -> str:
    return os.environ.get('WEB_SEARCH_TOOL_NAME', 'web-search-tool___WebSearch')


def _region_from_gateway_url(url: str) -> str:
    """The gateway lives in its own region (web-search is us-east-1-only),
    which may differ from the Lambda's region — sign for the gateway's."""
    host = urlparse(url).hostname or ''
    match = re.search(r'\.gateway\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$', host)
    if match:
        return match.group(1)
    return os.environ.get('AWS_REGION', 'us-east-1')


def _signed_post(url: str, payload: dict) -> dict:
    """POST a JSON-RPC payload to the gateway MCP endpoint with SigV4."""
    body = json.dumps(payload)
    credentials = _get_credentials()
    if credentials is None:
        raise WebSearchError('No AWS credentials available to sign the gateway request')

    request = AWSRequest(
        method='POST',
        url=url,
        data=body,
        headers={
            'Content-Type': 'application/json',
            # Streamable-HTTP MCP servers may answer either plain JSON or SSE.
            'Accept': 'application/json, text/event-stream',
        },
    )
    SigV4Auth(credentials, 'bedrock-agentcore', _region_from_gateway_url(url)).add_auth(request)

    http_request = urllib.request.Request(  # noqa: S310 — https gateway URL from CDK config
        url,
        data=body.encode('utf-8'),
        headers=dict(request.headers),
        method='POST',
    )
    try:
        with urllib.request.urlopen(http_request, timeout=_REQUEST_TIMEOUT_SECONDS) as response:  # noqa: S310
            content_type = response.headers.get('Content-Type', '')
            raw = response.read().decode('utf-8')
    except Exception as e:
        raise WebSearchError(f'Gateway request failed: {e}') from e

    return _parse_jsonrpc_response(raw, content_type)


def _parse_jsonrpc_response(raw: str, content_type: str) -> dict:
    """Parse a JSON-RPC response that may arrive as plain JSON or as an SSE
    frame (`data: {...}`), depending on how the gateway answers."""
    text = raw.strip()
    if 'text/event-stream' in content_type or text.startswith(('event:', 'data:')):
        for line in text.splitlines():
            if line.startswith('data:'):
                text = line[len('data:'):].strip()
                break
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise WebSearchError(f'Gateway returned non-JSON response: {text[:200]}') from e
    if not isinstance(parsed, dict):
        raise WebSearchError('Gateway returned unexpected JSON-RPC shape')
    return parsed


def _rpc(method: str, params: dict) -> dict:
    """Issue one JSON-RPC call and return its `result`, raising on `error`."""
    response = _signed_post(_gateway_url(), {
        'jsonrpc': '2.0',
        'id': 1,
        'method': method,
        'params': params,
    })
    if 'error' in response:
        error = response['error']
        message = error.get('message', str(error)) if isinstance(error, dict) else str(error)
        raise WebSearchError(f'Gateway {method} error: {message}')
    result = response.get('result')
    if not isinstance(result, dict):
        raise WebSearchError(f'Gateway {method} returned no result')
    return result


def _discover_tool_name() -> str:
    """Find the WebSearch tool via tools/list (name is target-prefixed,
    e.g. `web-search-tool___WebSearch`).

    Reads only the first page: MCP tools/list can paginate via nextCursor,
    but this gateway exposes a single connector target with one tool.
    """
    result = _rpc('tools/list', {})
    tools = result.get('tools', [])
    for tool in tools:
        name = tool.get('name', '') if isinstance(tool, dict) else ''
        if name.endswith('WebSearch'):
            return name
    raise WebSearchError('No WebSearch tool exposed by the gateway')


def _is_unknown_tool_error(error: WebSearchError) -> bool:
    return 'tool' in str(error).lower() and (
        'not found' in str(error).lower() or 'unknown' in str(error).lower()
    )


def _call_web_search_tool(query: str, max_results: int) -> dict:
    """tools/call with the configured (or previously discovered) name; on an
    unknown-tool error — including a stale cached name after a target rename
    — discover the real name via tools/list and retry once."""
    tool_name = _resolved_tool_name['name'] or _configured_tool_name()
    arguments = {'query': query, 'maxResults': max_results}
    try:
        result = _rpc('tools/call', {'name': tool_name, 'arguments': arguments})
    except WebSearchError as e:
        if not _is_unknown_tool_error(e):
            raise
        discovered = _discover_tool_name()
        logger.info(f"Web search tool name resolved via tools/list: {discovered}")
        _resolved_tool_name['name'] = discovered
        result = _rpc('tools/call', {'name': discovered, 'arguments': arguments})
    else:
        _resolved_tool_name['name'] = tool_name
    return result


def _extract_results(tool_result: dict) -> list[dict]:
    """Unwrap the MCP envelope: content[0].text is a serialized JSON document
    with an `id` and a `results` array of observations."""
    if tool_result.get('isError'):
        content = tool_result.get('content', [])
        detail = content[0].get('text', '') if content and isinstance(content[0], dict) else ''
        raise WebSearchError(f'Web search tool error: {detail[:300]}')

    content = tool_result.get('content', [])
    if not content or not isinstance(content[0], dict):
        raise WebSearchError('Web search returned an empty MCP content block')
    try:
        payload = json.loads(content[0].get('text', ''))
    except json.JSONDecodeError as e:
        raise WebSearchError('Web search returned non-JSON result text') from e

    raw_results = payload.get('results', []) if isinstance(payload, dict) else []
    results = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            continue
        text = str(raw.get('text', '') or '')
        if not text:
            continue
        results.append({
            'title': str(raw.get('title') or ''),
            'url': str(raw.get('url') or ''),
            'text': text,
            'published_date': str(raw.get('publishedDate') or ''),
        })
    return results


@tracer.capture_method
def search_web(query: str, max_results: int = DEFAULT_MAX_RESULTS) -> list[dict]:
    """Run one web search and return normalized observations.

    Returns a list of {title, url, text, published_date} dicts. Knowledge-graph
    observations (structured facts) come back with empty title/url and are kept
    — their text is high-confidence factual grounding.

    Raises WebSearchError on any failure; callers must treat web results as
    optional enrichment.
    """
    if not is_web_search_configured():
        raise WebSearchError('Web search is not configured (WEB_SEARCH_GATEWAY_URL unset)')
    trimmed = query.strip()[:MAX_QUERY_LENGTH]
    if not trimmed:
        raise WebSearchError('Web search query is empty')
    clamped = max(1, min(int(max_results), MAX_RESULTS_CAP))

    tool_result = _call_web_search_tool(trimmed, clamped)
    results = _extract_results(tool_result)
    logger.info(f"Web search returned {len(results)} results for query ({len(trimmed)} chars)")
    return results


def format_web_results_for_llm(results: list[dict]) -> str:
    """Format results for prompt context, keeping URLs/titles so the model can
    (and the acceptable-use policy says it must) cite sources."""
    if not results:
        return ''
    lines = []
    for i, result in enumerate(results, 1):
        title = result.get('title') or 'Knowledge graph fact'
        url = result.get('url') or ''
        published = result.get('published_date') or ''
        header = f"{i}. {title}"
        if published:
            header += f" ({published})"
        if url:
            header += f"\n   Source: {url}"
        snippet = (result.get('text') or '')[:1200]
        lines.append(f"{header}\n   {snippet}")
    return '\n\n'.join(lines)
