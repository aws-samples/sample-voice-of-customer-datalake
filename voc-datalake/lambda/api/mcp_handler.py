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
import re
from datetime import datetime, timezone, timedelta
from typing import Any

from aws_lambda_powertools import Logger, Tracer, Metrics
from boto3.dynamodb.conditions import Key
# Imported as a module because botocore's own `ConnectionError` would shadow the builtin.
from botocore import exceptions as botocore_exceptions

from shared.aws import get_dynamodb_resource
from shared.api import DecimalEncoder, validate_date_basis
from shared.feedback import query_feedback_by_date
from shared.mcp_tokens import (
    MCP_TOKEN_PK,
    REACH_KIND_PROJECT,
    REACH_KIND_WORKSPACE,
    REACH_NONE,
    REACH_PROJECT_SET,
    SCOPE_FEEDBACK_READ,
    SCOPE_METRICS_READ,
    SCOPE_PROJECTS_READ,
    DEFAULT_READ_REACH,
    parse_token,
    reach_allows,
    secret_matches,
    token_sk,
)
from shared.tables import get_projects_table, get_feedback_table, get_aggregates_table
from shared.indexes import FEEDBACK_BY_ID_INDEX
from projects import autoseed_project

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-MCP")

# AWS Clients
dynamodb = get_dynamodb_resource()

# Configuration
projects_table = get_projects_table()
feedback_table = get_feedback_table()
aggregates_table = get_aggregates_table()

# MCP Protocol version
MCP_PROTOCOL_VERSION = "2024-11-05"

# The credential format lives in shared/mcp_tokens.py — this module does not
# spell the prefix. It used to, as did projects_handler and an inline authorizer
# in api-stack.ts, three copies of one rule.

# The one origin a BROWSER may present. Not a CORS setting (see CORS_HEADERS
# below) — it is the allowlist for the MCP spec's DNS-rebinding guard, which
# REQUIRES that an invalid Origin be refused with 403. Real MCP clients are not
# browsers and send no Origin header at all; those requests are untouched.
# In dev deployments the stack sets '*', which disables the check.
ALLOWED_ORIGIN = os.environ.get('ALLOWED_ORIGIN', '')


# ============================================
# CORS helpers
# ============================================

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    # X-Project-Id is gone: the credential carries its own project reach, so a
    # client has no reason to send it and allowing it would keep a dead contract
    # looking alive.
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    # Without this a BROWSER-based MCP client can receive the 401 challenge but
    # never read it: WWW-Authenticate is not a CORS-safelisted response header.
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
}

# RFC 6750 §3: a 401 for a protected resource carries a WWW-Authenticate
# challenge. MCP clients read it to learn the auth scheme; its absence is a
# spec-conformance gap, not merely a nicety. `resource_metadata` is added when
# the well-known route lands (plan §4.4 Track A).
#
# ⚠️ Delivery caveat, verified live 2026-08-18: REST API Gateway
# unconditionally renames this header to `x-amzn-remapped-www-authenticate`
# on Lambda proxy responses (documented, no opt-out). Keep sending it — the
# value reaches clients under the remapped name, and gateway-GENERATED 401s
# (the token authorizer's shape rejections) carry the true header via the
# Unauthorized gateway response in api-stack.ts.
_WWW_AUTHENTICATE_401 = 'Bearer error="invalid_token"'


def _cors_response(body: dict, status_code: int = 200) -> dict:
    """Return a Lambda proxy response with CORS headers.

    Every 401 gains the RFC 6750 challenge here, at the one choke point all
    responses pass through, so no future 401 path can forget it.
    """
    headers = {**CORS_HEADERS, 'Content-Type': 'application/json'}
    if status_code == 401:
        headers['WWW-Authenticate'] = _WWW_AUTHENTICATE_401
    return {
        'statusCode': status_code,
        'headers': headers,
        'body': json.dumps(body, cls=DecimalEncoder),
    }


def _origin_allowed(event: dict) -> bool:
    """DNS-rebinding guard: reject a browser-presented Origin that is not ours.

    The MCP Streamable HTTP transport REQUIRES servers to validate the Origin
    header and answer 403 when it is present and invalid — a malicious page can
    otherwise use DNS rebinding to reach this endpoint from a victim's browser.

    Absent Origin (every non-browser MCP client) passes. A configured origin of
    '*' (dev deployments) passes everything. Comparison is exact-string on the
    scheme+host+port tuple the browser sends — no normalisation, mirroring the
    strictness the MCP auth spec demands for issuer comparison.
    """
    headers = event.get('headers') or {}
    origin = headers.get('origin') or headers.get('Origin') or ''
    if not origin:
        return True
    if ALLOWED_ORIGIN == '*':
        return True
    return origin == ALLOWED_ORIGIN


# ============================================
# Token authentication
# ============================================

# DynamoDB error codes that mean "the lookup could not be performed right now".
# The token may well be valid, so these are reported as an authentication
# failure (401) — a retry can succeed.
_RETRYABLE_DYNAMODB_ERRORS: frozenset[str] = frozenset({
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'ThrottlingException.TooManyRequests',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
    'TransactionConflictException',
})

# The transient half of the BotoCoreError family: a connection or timeout fault
# behaves like a throttle, so 401 (with a retry) is an acceptable answer.  The two
# *base* classes are named rather than their leaves, so a transient leaf botocore
# adds later is covered by inheritance instead of by an edit here.  Neither base is
# an ancestor of NoCredentialsError, NoRegionError or ParamValidationError, so no
# configuration fault is reclassified as transient.
_RETRYABLE_BOTOCORE_ERRORS: tuple[type[botocore_exceptions.BotoCoreError], ...] = (
    botocore_exceptions.ConnectionError,
    botocore_exceptions.HTTPClientError,
)


def _credential_expired(item: dict) -> bool:
    """True when a matched token row must be refused because of its expiry.

    Expiry is enforced HERE, in the credential check, not by a DynamoDB TTL:
    TTL deletion is eventual (up to ~48 h), so a TTL alone would keep an
    expired credential working for up to two days after its stated end.

    An absent or empty ``expires_at`` means a non-expiring token — every row
    minted before the field existed keeps working. A malformed value fails
    CLOSED (the credential is refused, and the row's token_id is logged so an
    operator can fix it): an unreadable expiry must not become an unlimited
    one. Only the token_id — never the token or its hash — reaches the log.

    Log severities differ on purpose: an EXPIRED token is an expected lifecycle
    event (info — the caller re-mints and moves on), while a MALFORMED value is
    server-side data damage nobody can fix from the client (warning — it wants
    an operator).
    """
    expires_at = item.get('expires_at')
    if not expires_at:
        return False
    try:
        expired = datetime.fromisoformat(expires_at) <= datetime.now(timezone.utc)
    except (TypeError, ValueError):
        logger.warning(
            'Token has malformed expires_at; refusing credential',
            extra={'token_id': item.get('token_id', '')},
        )
        return True
    if expired:
        logger.info(
            'Expired token presented',
            extra={'token_id': item.get('token_id', '')},
        )
    return expired


class AuthBackendUnavailable(Exception):
    """The token store could not be consulted, so the credential was never compared.

    Raised for *permanent* faults — an unset table name, a missing/misnamed table
    (``ResourceNotFoundException``), an IAM ``AccessDeniedException``, absent
    credentials (``NoCredentialsError``), … — and for any *unrecognised* fault out
    of the token lookup.  Callers must answer with a server error: a 401 here says
    the token is invalid when nothing ever checked it.
    """


@tracer.capture_method
def _authenticate(event: dict) -> dict | None:
    """
    Validate Bearer token from Authorization header.

    Returns the token DynamoDB item (with project_id, scope, etc.) on success,
    or None if authentication fails.

    Raises:
        AuthBackendUnavailable: the token store could not be consulted because
            of a permanent server-side fault.  Callers must answer with a
            server error, not a 401 — the credential was never checked.
    """
    headers = event.get('headers', {})
    # API Gateway lowercases header names in proxy mode
    auth_header = headers.get('authorization') or headers.get('Authorization') or ''

    if not auth_header.startswith('Bearer '):
        return None

    # NO X-Project-Id. The credential carries its own id, so the lookup is one
    # keyed read instead of "Query a project's token rows and hash each one" —
    # which is what required the header, and what made a workspace-wide tool
    # such as list_projects unimplementable. Parsing is strict, so malformed
    # caller text never becomes a key lookup.
    parsed = parse_token(auth_header[7:])  # strip "Bearer "
    if not parsed:
        return None
    token_id, presented_secret = parsed

    if not projects_table:
        # An unset PROJECTS_TABLE is the same class of fault as a missing table
        # *resource* (ResourceNotFoundException below): the credential was never
        # checked.  Returning None here would answer 401 for one and 500 for the
        # other, sending an operator off to re-mint tokens for what is a
        # deployment problem.
        logger.error("Projects table not configured")
        raise AuthBackendUnavailable('projects table not configured')

    # ONE item, addressed by the id inside the credential. A Query with an
    # exact sort key rather than get_item on purpose: it is the same single-item
    # read, and it keeps the IAM grant at exactly Query + UpdateItem — the
    # narrowed grant that makes this bearer-token-reachable function unable to
    # write project artifacts. Adding GetItem would widen it for no gain.
    try:
        response = projects_table.query(
            KeyConditionExpression=(
                Key('pk').eq(MCP_TOKEN_PK) & Key('sk').eq(token_sk(token_id))
            ),
        )
    except botocore_exceptions.ClientError as exc:
        # A throttle or transient service fault: the token may be fine, so a
        # 401 (with a retry) is an acceptable answer.  A permanent fault —
        # missing table, AccessDenied — is a server problem and must not be
        # reported to the client as "your token is invalid".
        error_code = exc.response.get('Error', {}).get('Code', '')
        if error_code in _RETRYABLE_DYNAMODB_ERRORS:
            logger.warning(
                'Token lookup temporarily unavailable',
                extra={'error_code': error_code},
            )
            return None
        logger.exception(
            'Token lookup failed with a permanent error; reporting a server error',
            extra={'error_code': error_code},
        )
        raise AuthBackendUnavailable(error_code or 'ClientError') from exc
    except botocore_exceptions.BotoCoreError as exc:
        # BotoCoreError is a sibling of ClientError, not a subclass, so it needs
        # this clause or it escapes as a 502 with no JSON-RPC envelope and no
        # CORS headers.  Split exactly as above: a connection/timeout fault is
        # transient, anything else in the family is a configuration fault that
        # re-minting a token cannot fix.  Only the exception *type* is logged —
        # never the token or its hash.
        error_type = type(exc).__name__
        if isinstance(exc, _RETRYABLE_BOTOCORE_ERRORS):
            logger.warning(
                'Token lookup temporarily unavailable',
                extra={'error_type': error_type},
            )
            return None
        logger.exception(
            'Token lookup failed with a permanent client-side error; reporting a server error',
            extra={'error_type': error_type},
        )
        raise AuthBackendUnavailable(error_type) from exc
    except Exception as exc:
        # Catches whatever escaped both clauses above; ordered last so those two
        # still win.  It RAISES, and must never be "simplified" into `return
        # None`: this guard was `return None` once and that was the bug —
        # configuration faults reported to the client as "your token is invalid".
        # An unrecognised fault means the credential was never compared, so a
        # server error is the only honest answer.
        error_type = type(exc).__name__
        logger.exception(
            'Token lookup failed with an unexpected error; reporting a server error',
            extra={'error_type': error_type},
        )
        raise AuthBackendUnavailable(error_type) from exc

    items = response.get('Items', [])
    if not items:
        # No such token id. Indistinguishable to the caller from a wrong
        # secret: both are a plain 401.
        return None
    item = items[0]

    stored_hash = item.get('secret_hash', '')
    # Guard against a malformed row where secret_hash is stored as a non-string
    # type (Binary, Decimal, …). Calling .encode() on such a value would raise
    # AttributeError and turn one bad row into a 500 instead of a 401. Log the
    # type so an operator can clean it up, never the value.
    if not isinstance(stored_hash, str):
        logger.warning(
            'Unexpected secret_hash type in DynamoDB item; refusing credential',
            extra={'type': type(stored_hash).__name__, 'token_id': item.get('token_id', '')},
        )
        return None

    # Constant-time, to deny timing-based enumeration of the stored digest.
    if not secret_matches(presented_secret=presented_secret, stored_hash=stored_hash):
        return None

    # Checked AFTER the secret matches, so a wrong secret and an expired
    # credential cost the same work.
    if _credential_expired(item):
        return None

    try:
        projects_table.update_item(
            Key={'pk': MCP_TOKEN_PK, 'sk': item['sk']},
            UpdateExpression='SET last_used_at = :now',
            ExpressionAttributeValues={':now': datetime.now(timezone.utc).isoformat()},
        )
    except Exception as e:
        logger.warning(f"Failed to update last_used_at: {e}")

    return item


# ============================================
# MCP Tool definitions
# ============================================

# The project argument shared by the project-shaped tools. One definition so
# the two schemas cannot drift, and so the "optional when unambiguous" rule is
# stated to clients exactly once.
_PROJECT_ID_ARG = {
    "type": "string",
    "description": (
        "Which project to read. Optional when this credential names exactly one "
        "project, in which case that one is used; required otherwise."
    ),
}

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
                "date_basis": {
                    "type": "string",
                    "enum": ["imported", "review"],
                    "description": (
                        "Which date the days window applies to: 'imported' (default, "
                        "when the item entered the data lake) or 'review' (when the "
                        "customer wrote it)"
                    ),
                    "default": "imported",
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
            "Get details of a project including personas, documents (PRDs, PR/FAQs), "
            "and project metadata."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "list_personas",
        "description": (
            "List all personas for a project with their demographics, "
            "pain points, goals, and behavioral traits."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
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
    date_basis = validate_date_basis(args.get('date_basis'))

    items = query_feedback_by_date(
        feedback_table,
        days=days,
        sources=[source] if source else None,
        categories=[category] if category else None,
        sentiments=[sentiment] if sentiment else None,
        limit=limit,
        date_basis=date_basis,
    )

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


_DEFAULT_METRICS_DAYS = 7
_MAX_METRICS_DAYS = 30


def _resolve_days(raw: Any) -> int:
    """Coerce and clamp a caller-supplied ``days`` argument to 1..30.

    Pure helper.  A missing or non-numeric value falls back to the default
    rather than raising, so ``period_days`` is always an ``int`` inside the
    advertised range regardless of what the client sent.  That includes the
    infinities: ``json`` parses both ``1e400`` and ``Infinity`` to ``inf``, and
    ``int(float('inf'))`` raises ``OverflowError`` rather than the ``ValueError``
    a non-numeric string gives, so ``OverflowError`` is caught alongside them —
    without it, ``{"days": 1e400}`` bypassed this fallback and surfaced as an
    opaque error from the ``_handle_tools_call`` catch-all.

    A value that is not an integer *by the tool's own ``inputSchema``* also
    falls back rather than being silently reinterpreted: JSON Schema counts
    neither ``true`` nor ``2.9`` as an integer, but ``int(True) == 1`` and
    ``int(2.9) == 2`` in Python, so coercing them would answer a window the
    caller never asked for.  A numeric *string* is still accepted — ``"14"``
    can only mean 14, and the resolved value is echoed back as ``period_days``.
    """
    if raw is None:
        return _DEFAULT_METRICS_DAYS
    # isinstance(True, int) is True in Python, so bools must be excluded before
    # the int() call or `days: true` quietly becomes a 1-day window.
    if isinstance(raw, bool):
        return _DEFAULT_METRICS_DAYS
    try:
        days = int(raw)
    except (TypeError, ValueError, OverflowError):
        # OverflowError is the infinities: int(float('inf')) raises it, not
        # ValueError, and json parses 1e400 / Infinity to inf.  int(float('nan'))
        # does raise ValueError, so NaN is covered by the clause above.
        return _DEFAULT_METRICS_DAYS
    # Fractional input: int() truncates, which narrows the window rather than
    # rejecting it.  Strings are exempt — int("14") is exact, and "14" != 14.
    if not isinstance(raw, str) and days != raw:
        return _DEFAULT_METRICS_DAYS
    return max(1, min(days, _MAX_METRICS_DAYS))


@tracer.capture_method
def _tool_get_metrics_summary(args: dict, _token_info: dict) -> list[dict]:
    """Get aggregated metrics summary.

    Mirrors the ``is_partial`` convention used by the REST metrics endpoints:
    if any underlying DynamoDB read raises, the partial result is still returned
    (so the readable portion is not lost), but ``is_partial`` is set to ``True``
    and the failure is logged at WARNING level — without any token or hash.
    """
    # Resolve `days` once, before the early exit, so both paths report the same
    # window.  The value is caller-supplied and echoed back as `period_days`,
    # so coerce it as well as clamp it: `inputSchema` declares "integer" but
    # nothing enforces that server-side, and `min()` against a str raises.
    days = _resolve_days(args.get('days'))

    if not aggregates_table:
        return [{"type": "text", "text": json.dumps({
            "is_partial": True,
            "error": "Aggregates table not configured",
            "period_days": days,
            "total_feedback": 0,
            "sentiment_breakdown": {},
            "top_categories": {},
        })}]

    current_date = datetime.now(timezone.utc)

    total = 0
    sentiment_counts: dict[str, int] = {}
    category_counts: dict[str, int] = {}
    is_partial = False

    for i in range(days):
        date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')

        # Daily total
        try:
            resp = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
            item = resp.get('Item')
            if item:
                total += int(item.get('count', 0))
        except Exception as exc:
            logger.warning("Failed to read daily_total aggregate", extra={"date": date, "error": str(exc)})
            is_partial = True

        # Sentiment counts
        for sent in ['positive', 'negative', 'neutral', 'mixed']:
            try:
                resp = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sent}', 'sk': date})
                item = resp.get('Item')
                if item:
                    sentiment_counts[sent] = sentiment_counts.get(sent, 0) + int(item.get('count', 0))
            except Exception as exc:
                logger.warning(
                    "Failed to read sentiment aggregate",
                    extra={"sentiment": sent, "date": date, "error": str(exc)},
                )
                is_partial = True

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
    except Exception as exc:
        logger.warning("Failed to read category_breakdown aggregate", extra={"error": str(exc)})
        is_partial = True

    summary = {
        "period_days": days,
        "total_feedback": total,
        "is_partial": is_partial,
        "sentiment_breakdown": sentiment_counts,
        "top_categories": dict(sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:10]),
    }

    return [{"type": "text", "text": json.dumps(summary, indent=2)}]


@tracer.capture_method
def _tool_get_project(args: dict, token_info: dict) -> list[dict]:
    """Get project details including personas and documents.

    `project_id` is the project _handle_tools_call resolved from the arguments
    (or the token's single project) AND authorized against the token's read
    reach. It is not "the token's project" any more — a credential can reach
    several — so this must not be re-derived here.
    """
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
    """List personas with full details.

    `project_id` is resolved and authorized by _handle_tools_call — see
    _tool_get_project.
    """
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
        IndexName=FEEDBACK_BY_ID_INDEX,
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

# The scope each registered tool requires, from the vocabulary in
# shared/mcp_tokens.py.
#
# Every entry in TOOL_HANDLERS MUST appear here. The dispatch in
# _handle_tools_call is fail-closed: a tool with no declared scope is rejected
# rather than defaulting to allowed, so an author who adds a handler without
# updating this table gets an immediate error at call time rather than an
# accidentally-public endpoint.
#
# Scopes are now per-domain (`feedback:read`, not `read`), so a token can be
# minted that reads feedback without reading anybody's product strategy. The
# previous single `read`/`read-write` pair could not express that, and its
# `read-write` half was a phantom — mintable, stored and badged in the UI while
# no tool ever required it.
TOOL_SCOPE_REQUIREMENTS: dict[str, str] = {
    "search_feedback": SCOPE_FEEDBACK_READ,
    "get_feedback_detail": SCOPE_FEEDBACK_READ,
    "get_metrics_summary": SCOPE_METRICS_READ,
    "get_project": SCOPE_PROJECTS_READ,
    "list_personas": SCOPE_PROJECTS_READ,
}

# How each tool's data is SHAPED, which decides how the token's read_reach
# applies to it (shared.mcp_tokens.reach_allows).
#
# `workspace` — the data has no project dimension at all. The feedback corpus
#   is keyed `SOURCE#{platform}` with no project_id, and metrics are workspace
#   aggregates. A token whose reach is `project-set` therefore cannot call
#   these: there is nothing to narrow, so allowing them would hand a supposedly
#   sealed credential the entire verbatim history.
# `project` — the tool addresses exactly one project, named by a `project_id`
#   argument (or defaulted from the token's project set when unambiguous), and
#   that project must be within reach.
#
# Also fail-closed: a tool with no declared reach kind is rejected.
TOOL_REACH_KINDS: dict[str, str] = {
    "search_feedback": REACH_KIND_WORKSPACE,
    "get_feedback_detail": REACH_KIND_WORKSPACE,
    "get_metrics_summary": REACH_KIND_WORKSPACE,
    "get_project": REACH_KIND_PROJECT,
    "list_personas": REACH_KIND_PROJECT,
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


def _scope_allows(token_scopes: Any, required_scope: str) -> bool:
    """Return True when the token's scope set contains *required_scope*.

    Pure predicate — no side effects. Callers are responsible for logging when
    this returns False.

    Exact membership, with no hierarchy: scopes are per-domain, so nothing
    "includes" anything else and there is no ordering to get wrong. A row whose
    `scopes` is missing or not a list of strings grants NOTHING rather than
    falling back to a default — the old code defaulted a missing scope to
    "read" because deployed rows predated the field, but the format change
    means every row now carries an explicit set, so a row without one is data
    damage and must not be guessed at.
    """
    if not required_scope:
        return False
    if not isinstance(token_scopes, (list, tuple, set, frozenset)):
        return False
    return required_scope in token_scopes


class InvalidProjectArgument(Exception):
    """`project_id` was supplied but is not a usable project id."""


def _resolve_project_id(args: dict, token_info: dict) -> str | None:
    """Which project a project-shaped tool is addressing, or None.

    Explicit argument wins. Absent, it defaults to the token's project set when
    that set names exactly one project — the common case, since a token is
    minted from a project — so single-project clients need not pass it. An
    ambiguous default (a set with several projects) resolves to None rather
    than picking one, which the caller sees as a request to name the project.

    🔑 A PRESENT but unusable argument (`123`, `["p"]`, `"  "`) RAISES rather
    than falling back to the token's project. Falling back would read a
    *different* project than the client named and report success, which is worse
    than an error: the caller gets someone else's data believing it is the
    project they asked for. Absence and garbage are different intents and get
    different answers.
    """
    if 'project_id' in args:
        explicit = args['project_id']
        if not isinstance(explicit, str) or not explicit.strip():
            raise InvalidProjectArgument(
                f'project_id must be a non-empty string, got '
                f'{type(explicit).__name__}'
            )
        return explicit.strip()
    token_projects = token_info.get('projects')
    if isinstance(token_projects, (list, tuple)) and len(token_projects) == 1:
        only = token_projects[0]
        return only if isinstance(only, str) and only else None
    return None


def _handle_tools_call(req_id: Any, params: dict, token_info: dict) -> dict:
    """Handle MCP tools/call request."""
    tool_name = params.get('name', '')
    arguments = params.get('arguments', {})

    # `arguments` is caller-controlled JSON and is NOT guaranteed to be an
    # object. A list, string or number reaches the project resolution below,
    # where both `'project_id' in args` and `args['project_id']` raise
    # TypeError — and that resolution runs OUTSIDE the try/except around the
    # handler, so it escapes as a 502 with no JSON-RPC envelope and no CORS
    # headers. Refused here at the boundary, which is the same lesson the
    # BotoCoreError clause in _authenticate records: an unhandled type is a
    # protocol-level 400, not a server crash.
    if not isinstance(arguments, dict):
        return _jsonrpc_error(
            req_id, -32602,
            f"'arguments' must be an object, got {type(arguments).__name__}",
        )

    handler = TOOL_HANDLERS.get(tool_name)
    if not handler:
        return _jsonrpc_error(req_id, -32602, f"Unknown tool: {tool_name}")

    # Scope enforcement — fail-closed: a tool with no declared requirement
    # is rejected rather than defaulting to allowed.
    required_scope = TOOL_SCOPE_REQUIREMENTS.get(tool_name)
    if required_scope is None:
        logger.error("Tool has no declared scope requirement", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, f"Tool {tool_name} has no declared scope requirement")

    # Same fail-closed treatment for the reach kind: without it there is no way
    # to know whether read_reach even applies to this tool, and guessing would
    # mean guessing in the permissive direction.
    tool_reach_kind = TOOL_REACH_KINDS.get(tool_name)
    if tool_reach_kind is None:
        logger.error("Tool has no declared reach kind", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, f"Tool {tool_name} has no declared reach kind")

    token_scopes = token_info.get('scopes')
    if not _scope_allows(token_scopes, required_scope):
        logger.warning(
            "Scope insufficient for tool",
            extra={"tool": tool_name, "required": required_scope},
        )
        return _jsonrpc_error(
            req_id, -32003,
            f"Forbidden: token lacks the '{required_scope}' scope required by '{tool_name}'",
        )

    # Reach enforcement. Separate from scope on purpose: scope says WHICH KIND
    # of data a token may read, reach says HOW FAR. A token can hold
    # `projects:read` and still be refused a particular project.
    read_reach = token_info.get('read_reach') or DEFAULT_READ_REACH
    token_projects = token_info.get('projects') or []
    project_id = None
    if tool_reach_kind == REACH_KIND_PROJECT:
        try:
            project_id = _resolve_project_id(arguments, token_info)
        except InvalidProjectArgument as exc:
            return _jsonrpc_error(req_id, -32602, str(exc))

    if not reach_allows(
        read_reach=read_reach,
        token_projects=token_projects,
        tool_reach_kind=tool_reach_kind,
        project_id=project_id,
    ):
        # The refusals read differently because they need different fixes: one
        # wants an argument, the other wants a differently-scoped token.
        #
        # Ordering, precisely — a MALFORMED argument is reported earlier, by
        # _resolve_project_id, because an ill-formed request is ill-formed
        # whatever the token's reach (syntax before authorization, as everywhere
        # else). What is checked reach-first is the MISSING-argument case below:
        # a `none`-reach token can never call anything, so asking it for a
        # project_id would send the caller after an argument that cannot help.
        reach_covers_nothing = (
            read_reach == REACH_NONE
            or (read_reach == REACH_PROJECT_SET and tool_reach_kind == REACH_KIND_WORKSPACE)
        )
        if tool_reach_kind == REACH_KIND_PROJECT and not project_id and not reach_covers_nothing:
            return _jsonrpc_error(
                req_id, -32602,
                f"'{tool_name}' needs a project_id argument: this token's project "
                f"set does not name exactly one project",
            )
        logger.warning(
            "Read reach does not cover this call",
            extra={"tool": tool_name, "read_reach": read_reach, "kind": tool_reach_kind},
        )
        return _jsonrpc_error(
            req_id, -32003,
            f"Forbidden: this token's read reach ('{read_reach}') does not cover "
            f"'{tool_name}'",
        )

    if tool_reach_kind == REACH_KIND_PROJECT:
        # The AUTHORIZED project for this one call, which is what the
        # project-shaped tools read. Injected rather than passed as a new
        # parameter so resolution and authorization stay in this one place
        # instead of being repeated per tool.
        token_info = {**token_info, 'project_id': project_id}

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
    """Handle GET /mcp/autoseed/{project_id} with Bearer token auth.

    The project_id comes from the URL path (injected into pathParameters by the
    router). It no longer has to be echoed into an X-Project-Id header: the
    credential resolves on its own, so the path is simply the project being
    asked for, and the token's reach decides whether that is allowed.
    """
    path_params = event.get('pathParameters', {}) or {}
    project_id = path_params.get('project_id', '')

    try:
        token_info = _authenticate(event)
    except AuthBackendUnavailable:
        # A server-side fault in the token store, not a bad credential.
        return _cors_response(
            {'message': 'Token store unavailable'}, status_code=500
        )
    if not token_info:
        return _cors_response({'message': 'Unauthorized'}, status_code=401)

    # Autoseed hands back the project's personas and documents, so it is a
    # project-shaped read of exactly the kind get_project performs, and it goes
    # through the same gate — including the scope check, which the old
    # equality-against-the-token's-project test did not perform at all.
    if not _scope_allows(token_info.get('scopes'), SCOPE_PROJECTS_READ):
        return _cors_response(
            {'message': f"Forbidden: token lacks the '{SCOPE_PROJECTS_READ}' scope"},
            status_code=403,
        )
    if not reach_allows(
        read_reach=token_info.get('read_reach') or DEFAULT_READ_REACH,
        token_projects=token_info.get('projects') or [],
        tool_reach_kind=REACH_KIND_PROJECT,
        project_id=project_id,
    ):
        return _cors_response(
            {'message': 'Forbidden: project is outside this token\'s read reach'},
            status_code=403,
        )

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

    # DNS-rebinding guard, FIRST — before auth, before method dispatch, and
    # including OPTIONS. The MCP transport spec requires 403 for a present,
    # invalid Origin; checking before _authenticate also means a rebound page
    # cannot use a victim's browser to probe the token store at all.
    if not _origin_allowed(event):
        return _cors_response(
            _jsonrpc_error(None, -32600, "Forbidden: invalid Origin"),
            status_code=403,
        )

    # Handle CORS preflight
    http_method = event.get('httpMethod', '')
    if http_method == 'OPTIONS':
        return _cors_response({})

    # Handle GET /mcp/autoseed/{project_id} (public, token auth)
    path = event.get('path', '')
    # Path from API Gateway includes stage: /v1/mcp/autoseed/{project_id}
    # Strip leading /v1 or any stage prefix, then match
    autoseed_match = re.match(r'(?:/[^/]+)?/mcp/autoseed/([^/]+)$', path)
    if http_method == 'GET' and autoseed_match:
        # Inject project_id into pathParameters for _handle_autoseed
        if 'pathParameters' not in event or event['pathParameters'] is None:
            event['pathParameters'] = {}
        event['pathParameters']['project_id'] = autoseed_match.group(1)
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
        try:
            token_info = _authenticate(event)
        except AuthBackendUnavailable:
            # The token store could not be consulted because of a server-side
            # fault (missing table, AccessDenied, …).  Answering 401 here would
            # send operators to re-mint tokens for a configuration problem, so
            # report it honestly as an internal error instead.
            return _cors_response(
                _jsonrpc_error(req_id, -32603, "Internal error: token store unavailable"),
                status_code=500,
            )
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
