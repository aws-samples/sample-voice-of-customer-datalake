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
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from aws_lambda_powertools import Logger, Tracer, Metrics
from boto3.dynamodb.conditions import Key
# Imported as a module because botocore's own `ConnectionError` would shadow the builtin.
from botocore import exceptions as botocore_exceptions

from shared.api import DecimalEncoder, SEARCH_QUERY_MIN_LENGTH
from shared.mcp_delegate import (
    DelegationUnavailable,
    DomainCall,
    DomainResult,
    call_domain,
    synthetic_claims,
)
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
from shared.tables import get_projects_table

logger = Logger()
tracer = Tracer()
metrics = Metrics(namespace="VoC-MCP")

# The ONLY table this function reads directly, and only its token partition:
# authentication is the one thing that cannot be delegated, because it is what
# decides who the delegated call is made as. Every tool's data now comes from
# the domain function that owns the route (shared/mcp_delegate.py), which is why
# FEEDBACK_TABLE and AGGREGATES_TABLE are gone from this Lambda's environment
# and its role no longer holds a grant on either.
projects_table = get_projects_table()

# MCP Protocol version
#
# ⚠️ KNOWN SKEW, and it is temporary by plan rather than by oversight.
# `structuredContent` and `outputSchema` (below) arrived in the 2025-06-18
# revision, while this still advertises 2024-11-05 and `initialize` declares no
# capability for them. The version range — negotiating 2026-07-28 / 2025-11-25 /
# 2025-06-18 and answering `server/discover` — is the next phase of the plan, and
# bumping the number here without that negotiation would claim conformance this
# handler does not yet have (no `resultType`, no header validation).
#
# Shipping the structured fields early is safe in the meantime because both are
# ADDITIVE: a 2024-11-05 client reads `content[0].text`, which still carries the
# same payload serialized, and JSON-RPC clients ignore result fields they do not
# know. The reverse order — negotiate first, add the fields later — would have
# meant two breaking output changes instead of one.
MCP_PROTOCOL_VERSION = "2024-11-05"

# Semver on the SERVER, independent of the protocol revision above, and the only
# signal a client gets that a tool's output shape moved — it is advertised in
# `serverInfo` on every `initialize`.
#
# 2.0.0 carried `structuredContent` alongside the text block, turned sad paths
# that used to arrive as prose in a successful result into tool errors, and made
# `get_project` report the documents it had been dropping.
#
# 3.0.0 changes the persona shape both persona-reporting tools publish:
# `list_personas` now mirrors `schemas/persona.schema.json` and no longer
# declares `goals`, `age_range`, `occupation`, `quote`, `journey_stage` or
# `type`, and `get_project`'s persona summary reports `tagline` in place of
# `type`. Those six keys existed on no stored row and `list_personas` was
# uncallable against real data, so nothing could have consumed them — but a
# client coded against the NAMES loses them, which is a major bump by this
# file's own rule rather than a judgement about how many clients exist.
#
# 3.1.0 ADDS `is_partial` to `search_feedback`'s output — an added field, which
# is a minor bump by the rule above. ⚠️ Minor does not mean invisible: these
# output shapes carry `additionalProperties: false` and a client validates
# against the `tools/list` it cached at CONNECT, so a session that predates the
# deploy rejects the new field until it reconnects. The server honestly declares
# `tools.listChanged: false`, so there is no notification path to tell it.
MCP_SERVER_VERSION = "3.1.0"


# ============================================
# Domain routes — the delegation map
# ============================================

# Which domain function owns which route. Two functions serve all five tools:
# the metrics Lambda owns /feedback/* and /metrics/*, the projects Lambda owns
# /projects/*. Adding a tool for a third domain means adding its function here
# AND a grantInvoke in api-stack.ts — the lockstep test in api-stack.test.ts
# fails if a route named here is not wired and invokable.
DOMAIN_METRICS = 'metrics'
DOMAIN_PROJECTS = 'projects'

_DOMAIN_FUNCTION_ENV: dict[str, str] = {
    DOMAIN_METRICS: 'METRICS_FUNCTION',
    DOMAIN_PROJECTS: 'PROJECTS_FUNCTION',
}

# route key → (owning domain, method, path template). Load-bearing at runtime
# (every call is built from it) so it cannot rot into stale documentation the
# way a test-only table would.
DOMAIN_ROUTES: dict[str, tuple[str, str, str]] = {
    'feedback_list': (DOMAIN_METRICS, 'GET', '/feedback'),
    'feedback_search': (DOMAIN_METRICS, 'GET', '/feedback/search'),
    'feedback_item': (DOMAIN_METRICS, 'GET', '/feedback/{feedback_id}'),
    'metrics_summary': (DOMAIN_METRICS, 'GET', '/metrics/summary'),
    # The four breakdown axes behind the single get_metrics_breakdown tool.
    'metrics_sentiment': (DOMAIN_METRICS, 'GET', '/metrics/sentiment'),
    'metrics_categories': (DOMAIN_METRICS, 'GET', '/metrics/categories'),
    'metrics_sources': (DOMAIN_METRICS, 'GET', '/metrics/sources'),
    'metrics_personas': (DOMAIN_METRICS, 'GET', '/metrics/personas'),
    'project_get': (DOMAIN_PROJECTS, 'GET', '/projects/{project_id}'),
    'project_autoseed': (DOMAIN_PROJECTS, 'GET', '/projects/{project_id}/autoseed'),
}


# ---------------------------------------------------------------------------
# Path-parameter confinement
# ---------------------------------------------------------------------------
#
# 🔑 A ROUTE-CONFUSION guard, not input tidiness. The delegated path is what the
# Powertools resolver matches on — `pathParameters` is never consulted — so a
# parameter value is not data, it is part of the routing key. Two ways an
# unvalidated value changes which route answers:
#
#   • EXTRA SEGMENTS. `project_id='p/api-tokens'` builds `/projects/p/api-tokens`
#     and lands on the token-list route instead of the project route.
#   • A COLLISION WITH A STATIC SIBLING. `project_id='prioritization'` builds
#     `/projects/prioritization`, and Powertools resolves static routes BEFORE
#     dynamic ones, so it lands on `api_get_prioritization_scores` — the surface
#     deliberately excluded from MCP altogether. Segment counting does not catch
#     this: it is a well-formed single segment.
#
# The guard is a SHAPE rule plus a reserved-segment set, deliberately NOT a
# format allowlist per id. An allowlist (`proj_…`, 32 hex) was the first
# implementation and it bet on id PROVENANCE: any project seeded, imported or
# minted by an older generator becomes permanently unreachable through MCP, and
# reported as a malformed argument rather than as a missing project. That trades
# a security property for an availability one, and it is avoidable — the shape
# rule stops segment injection, and the reserved set stops sibling collisions,
# without either caring where an id came from.
#
# The reserved sets are DERIVED from the owning handlers' static routes by
# `test_reserved_segments_cover_every_static_sibling`, so a new static sibling
# added to one of those handlers fails the suite instead of quietly becoming
# reachable. That is the same lockstep shape as the route and throttle tests.
_RESERVED_PATH_SEGMENTS: dict[str, frozenset[str]] = {
    '/projects': frozenset({'config', 'prioritization'}),
    '/feedback': frozenset({'search', 'urgent', 'entities'}),
}

# Characters that would let a value escape its segment or its path entirely.
# `/` is the injection above; `?` and `#` would graft a query or fragment onto
# the routing key; `%` would let a percent-encoded `/` arrive decoded at a
# resolver that has already matched.
_FORBIDDEN_PATH_CHARS = frozenset('/?#%\\')


def _reserved_for(template: str, name: str) -> frozenset[str]:
    """The static sibling segments a parameter must not impersonate.

    Keyed on the path PREFIX above the parameter, so `/projects/{project_id}` and
    `/projects/{project_id}/autoseed` share one set — both put the value in the
    same position, which is what decides which siblings it can collide with.

    FAILS CLOSED on a prefix with no entry, which is the property the previous
    format-allowlist version had and this one lost when it was rewritten: a
    `.get(prefix, frozenset())` silently permits sibling collisions for any
    future templated route whose prefix nobody remembered to declare, so adding
    a route becomes how the hole reopens. Declaring an explicit
    `frozenset()` is how a prefix with genuinely no static siblings opts out, and
    that is a deliberate line in a diff rather than an omission.
    """
    segments = template.strip('/').split('/')
    position = segments.index(f'{{{name}}}')
    prefix = '/' + '/'.join(segments[:position])
    if prefix not in _RESERVED_PATH_SEGMENTS:
        # DelegationUnavailable, not InvalidToolArgument: this is a SERVER
        # misconfiguration, and -32602 "Invalid params" would tell the caller its
        # arguments are wrong when nothing it could send would work. The state is
        # unreachable in a deployed build — the prefix lockstep fails first — so
        # this is about not lying if it ever is reached.
        logger.error('No reserved-segment set declared', extra={'prefix': prefix})
        raise DelegationUnavailable(f'no reserved-segment set declared for {prefix}')
    return _RESERVED_PATH_SEGMENTS[prefix]


def _validated_path_parameters(route_key: str, params: dict[str, str]) -> dict[str, str]:
    """Refuse any path parameter that could change which route answers."""
    _domain, _method, template = DOMAIN_ROUTES[route_key]
    for name, value in params.items():
        if f'{{{name}}}' not in template:
            # Fail closed rather than ignoring it: a parameter the template does
            # not interpolate means caller and route disagree about the call.
            raise InvalidToolArgument(f"{route_key}: unexpected path parameter '{name}'")
        # Distinct messages per condition: the caller can act on each of these
        # differently, and "must be a single path segment" for a stray space sends
        # them looking for a slash they never sent.
        if not isinstance(value, str) or not value:
            raise InvalidToolArgument(f'{name} must be a non-empty identifier')
        if value.strip() != value:
            # Split from the emptiness check on purpose: bundling them reported
            # "must be a non-empty identifier" for a value that plainly was not
            # empty, which is the same misdirection the messages below avoid.
            raise InvalidToolArgument(f'{name} must not be surrounded by whitespace')
        offending = sorted(_FORBIDDEN_PATH_CHARS & set(value))
        if offending:
            raise InvalidToolArgument(
                f'{name} may not contain {" ".join(offending)}: it must be a single path segment'
            )
        if any(c.isspace() or ord(c) < 0x20 for c in value):
            raise InvalidToolArgument(f'{name} may not contain whitespace or control characters')
        if value in {'.', '..'}:
            raise InvalidToolArgument(f'{name} may not be a relative path segment')
        if value in _reserved_for(template, name):
            # Named explicitly, because "not found" would be a lie and the caller
            # cannot otherwise tell why a plausible-looking id was refused.
            raise InvalidToolArgument(
                f"{name} may not be '{value}': that names a different route"
            )
    return params


def _domain_call(
    route_key: str,
    *,
    path_parameters: dict[str, str] | None = None,
    query: dict[str, Any] | None = None,
) -> DomainCall:
    """Build the call for a declared route, resolving its function name.

    The env var is read per call rather than captured at import so a test can
    set it, and so a missing one surfaces as this route being unconfigured
    rather than as the whole module failing to load.

    Every delegated call is built here — tools and the autoseed route alike — so
    this is the one place path parameters have to be confined.
    """
    domain, method, template = DOMAIN_ROUTES[route_key]
    params = _validated_path_parameters(route_key, dict(path_parameters or {}))
    return DomainCall(
        function_name=os.environ.get(_DOMAIN_FUNCTION_ENV[domain], ''),
        method=method,
        path=template.format(**params) if params else template,
        path_parameters=params,
        query=dict(query or {}),
    )


class ToolRouteError(Exception):
    """The delegated route refused the call — a 4xx the model should hear.

    Distinct from DelegationUnavailable (a 5xx or transport fault, which is a
    server problem the model cannot fix). The MCP spec draws exactly this line:
    input-validation and business-logic failures belong in the tool RESULT with
    `isError: true`, because a model can self-correct from them, while malformed
    requests and server faults belong in the JSON-RPC `error`.
    """


@dataclass(frozen=True)
class ToolResult:
    """A tool's answer: the structured payload plus its serialized text form.

    Both are returned because the spec says a tool SHOULD keep sending the
    serialized JSON in a `TextContent` for clients that predate structured
    output, and `structuredContent` is what a modern client validates against
    the tool's `outputSchema`. One value produces both, so they cannot drift.
    """

    structured: dict

    @property
    def text(self) -> str:
        return json.dumps(self.structured, indent=2, cls=DecimalEncoder)


def _delegate(call: DomainCall, token_info: dict) -> DomainResult:
    """Invoke a domain route and map its refusals onto the MCP error taxonomy."""
    result = call_domain(call, claims=synthetic_claims(token_info))
    if result.ok:
        return result
    if 400 <= result.status_code < 500:
        raise ToolRouteError(_route_error_message(result))
    # A 5xx from the route is a server fault, not something a model can fix.
    logger.error(
        'Delegated route returned a server error',
        extra={'route': f'{call.method} {call.path}', 'status': result.status_code},
    )
    raise DelegationUnavailable(f'{call.method} {call.path} returned {result.status_code}')


def _route_error_message(result: DomainResult) -> str:
    """The route's own message, so the model reads the real reason.

    Powertools serializes its exceptions as `{"message": ...}`; anything else is
    reported by status alone rather than by dumping an unknown body into the
    model's context.
    """
    payload = result.payload
    if isinstance(payload, dict):
        message = payload.get('message') or payload.get('error')
        if isinstance(message, str) and message:
            return message
    return f'The request was refused (HTTP {result.status_code})'

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

# How much of a verbatim a LIST answer carries. A single item is never
# truncated; twenty of them would otherwise crowd out the model's own reasoning.
_SUMMARY_TEXT_LIMIT = 500


# ---------------------------------------------------------------------------
# Output schemas
# ---------------------------------------------------------------------------
#
# `outputSchema` describes what a tool puts in `structuredContent`, so a client
# can validate the answer instead of parsing prose. The schemas are built from
# shared pieces for the same reason the projections are: the two feedback tools
# agree on ten fields, and two hand-maintained copies is how the declaration
# stops matching the code.
#
# 🔑 `additionalProperties` is deliberately NOT uniform, and the split is the
# honest one: a tool that PROJECTS its answer controls every key, so it declares
# `false` and a stray field becomes a test failure. A tool that PASSES THROUGH a
# route's payload does not control the keys — the route may add one tomorrow —
# so declaring `false` there would make this file the thing that breaks when a
# route grows a field, which is precisely the coupling delegation removes.

_FEEDBACK_SUMMARY_PROPERTIES: dict[str, Any] = {
    "id": {"type": "string"},
    "source": {"type": "string", "description": "Source platform"},
    "date": {"type": "string", "description": "YYYY-MM-DD"},
    "sentiment": {"type": "string"},
    "sentiment_score": {"type": "string", "description": "Stringified decimal"},
    "category": {"type": "string"},
    "urgency": {"type": "string"},
    "rating": {"type": "string", "description": "Stringified, or 'N/A'"},
    "persona_type": {"type": "string"},
    "text": {"type": "string", "description": f"Verbatim, first {_SUMMARY_TEXT_LIMIT} characters"},
    "problem_summary": {"type": "string"},
}

_FEEDBACK_DETAIL_PROPERTIES: dict[str, Any] = {
    **_FEEDBACK_SUMMARY_PROPERTIES,
    "date": {"type": "string", "description": "Full ISO-8601 timestamp"},
    "text": {"type": "string", "description": "Full verbatim, untruncated"},
    "journey_stage": {"type": "string"},
    "problem_root_cause": {"type": "string"},
    "direct_quote": {"type": "string"},
    "keywords": {"type": "array", "items": {"type": "string"}},
}

# The document sort-key prefixes, mapped to the kind of document each names.
#
# 🔑 This map is why delegating mattered. The in-process tool recognised two of
# these six — `PRD#` and `PRFAQ#` — so an MCP client saw a third of a project's
# documents and was told nothing had been filtered: no research reports, no
# uploaded documents, no product reports, no prototypes. The route always knew
# all six. Reading the kind from the sort key rather than from a `type`
# attribute is deliberate: the four formerly-invisible kinds do not all carry
# one, so keying on `type` alone would have made them visible but unlabelled.
_DOCUMENT_KINDS: dict[str, str] = {
    'PRD#': 'prd',
    'PRFAQ#': 'prfaq',
    'RESEARCH#': 'research',
    'DOC#': 'document',
    'PRODUCT_REPORT#': 'product_report',
    'PROTOTYPE#': 'prototype',
}

_STRING_LIST: dict[str, Any] = {"type": "array", "items": {"type": "string"}}

# The persona, mirroring `schemas/persona.schema.json` — the repo's canonical
# declaration, what both writers persist, and what the frontend
# `ProjectPersona` type already describes. Section numbers below are the
# canonical schema's own: 1-5 and 7 are objects and are declared here, 6
# (`quotes`) is an array declared under `_QUOTE_PROPERTIES`, and 8
# (`research_notes`) is researcher annotation rather than persona content and is
# deliberately not reported. That division is enforced against the schema file
# by `test_every_canonical_persona_section_is_reported_or_excluded`, so a ninth
# section cannot go missing here the way 5 and 7 first did.
#
# `additionalProperties` is deliberately OPEN on each section. These values are
# LLM-authored, and a prompt is a request rather than enforcement: live rows
# carry `primary_frustration`, `frustration`, `tooling`, `current_practices`,
# `related_issues`. Declaring `false` would make the tool fail on its own
# product; declaring the known keys and permitting the rest is the honest
# contract, and the variance belongs to the writer.
_PERSONA_SECTIONS: dict[str, dict[str, Any]] = {
    # Section 1 — Identity & Demographics.
    "identity": {
        "age_range": {"type": "string"},
        "location": {"type": "string"},
        "occupation": {"type": "string"},
        "income_bracket": {"type": "string"},
        "education": {"type": "string"},
        "family_status": {"type": "string"},
        "bio": {"type": "string"},
    },
    # Section 2 — Goals & Motivations.
    "goals_motivations": {
        "primary_goal": {"type": "string"},
        "secondary_goals": _STRING_LIST,
        "success_definition": {"type": "string"},
        "underlying_motivations": _STRING_LIST,
    },
    # Section 3 — Pain Points & Frustrations.
    "pain_points": {
        "current_challenges": _STRING_LIST,
        "blockers": _STRING_LIST,
        "workarounds": _STRING_LIST,
        "emotional_impact": {"type": "string"},
    },
    # Section 4 — Behaviors & Habits.
    "behaviors": {
        "current_solutions": _STRING_LIST,
        "tools_used": _STRING_LIST,
        "activity_frequency": {"type": "string"},
        "tech_savviness": {"type": "string"},
        "decision_style": {"type": "string"},
    },
    # Section 5 — Context & Environment.
    "context_environment": {
        "usage_context": {"type": "string"},
        "devices": _STRING_LIST,
        "time_constraints": {"type": "string"},
        "social_context": {"type": "string"},
        "influencers": _STRING_LIST,
    },
    # Section 7 — Scenario / User Story.
    "scenario": {
        "title": {"type": "string"},
        "narrative": {"type": "string"},
        "trigger": {"type": "string"},
        "outcome": {"type": "string"},
    },
}

# Section 6 — Representative Quotes. Objects on the row, not strings, and the
# old single `quote` key never existed. Named separately from the sections above
# because it is an array, so it needs its own projection.
#
# `source_feedback_id` is the quote's own citation and is declared, unlike the
# persona's top-level `source_feedback_ids`, which is dropped: one is where this
# sentence came from and is the id `get_feedback_detail` takes, the other is the
# row's provenance list.
_QUOTE_PROPERTIES: dict[str, Any] = {
    "text": {"type": "string"},
    "context": {"type": "string"},
    "source_feedback_id": {"type": "string"},
}

_PERSONA_PROPERTIES: dict[str, Any] = {
    "persona_id": {"type": "string"},
    "name": {"type": "string"},
    # `tagline` is the persona's one-line characterisation and is REQUIRED by the
    # canonical schema. It replaces the old `type`, which no row has ever carried.
    "tagline": {"type": "string"},
    "confidence": {"type": "string"},
    "feedback_count": {"type": "integer"},
    **{
        section: {
            "type": "object",
            "properties": properties,
            "additionalProperties": True,
        }
        for section, properties in _PERSONA_SECTIONS.items()
    },
    "quotes": {
        "type": "array",
        "items": {
            "type": "object",
            "properties": _QUOTE_PROPERTIES,
            "additionalProperties": True,
        },
    },
}


def _declared_types(properties: dict[str, Any]) -> dict[str, str]:
    """The declared JSON type of each property, so the projection can coerce to it.

    Read off the declarations by VALUE rather than by identity with
    `_STRING_LIST`: an author who inlines a literal instead of reusing the
    constant must still get coercion, or this derivation would have exactly the
    silent-omission hole it exists to close. Deriving EVERY type rather than
    only the arrays is what stops the next declared field from being the one
    nobody coerces — `confidence` was that field.
    """
    return {
        key: declared["type"]
        for key, declared in properties.items()
        if isinstance(declared.get("type"), str)
    }


_PERSONA_SECTION_TYPES: dict[str, dict[str, str]] = {
    section: _declared_types(properties)
    for section, properties in _PERSONA_SECTIONS.items()
}
_QUOTE_TYPES: dict[str, str] = _declared_types(_QUOTE_PROPERTIES)
# The top-level scalars only: the sections and `quotes` are objects and arrays of
# objects, each with its own projection below.
_PERSONA_SCALAR_TYPES: dict[str, str] = {
    key: declared_type
    for key, declared_type in _declared_types(_PERSONA_PROPERTIES).items()
    if declared_type not in ("object", "array")
}

# Each projected feedback key, mapped to the row keys it reads — first non-empty
# wins.
#
# 🔑 This map exists so the feedback projection can be driven by its own
# declarations, exactly as `_project_persona` is. It could not simply iterate the
# declared properties against the row, because this projection RENAMES
# (`source_platform`→`source`, `original_text`→`text`,
# `problem_root_cause_hypothesis`→`problem_root_cause`), so the declared key is
# not the key to read. Stating the mapping once is what lets EVERY declared field
# be coerced instead of the handful someone remembered to wrap in `str()`.
#
# `id` is the only multi-key entry, preserving the existing fallback: the
# processor writes `feedback_id`, and a row that happens to carry a plain `id` is
# not worth breaking to make a point.
_FEEDBACK_SOURCE_KEYS: dict[str, tuple[str, ...]] = {
    "id": ('feedback_id', 'id'),
    "source": ('source_platform',),
    "date": ('source_created_at',),
    "sentiment": ('sentiment_label',),
    "sentiment_score": ('sentiment_score',),
    "category": ('category',),
    "urgency": ('urgency',),
    "rating": ('rating',),
    "persona_type": ('persona_type',),
    "text": ('original_text',),
    "problem_summary": ('problem_summary',),
    "journey_stage": ('journey_stage',),
    "problem_root_cause": ('problem_root_cause_hypothesis',),
    "direct_quote": ('direct_customer_quote',),
    "keywords": ('keywords',),
}
_FEEDBACK_SUMMARY_TYPES: dict[str, str] = _declared_types(_FEEDBACK_SUMMARY_PROPERTIES)
_FEEDBACK_DETAIL_TYPES: dict[str, str] = _declared_types(_FEEDBACK_DETAIL_PROPERTIES)

# A window argument, stated once. `maximum` is the route's real ceiling
# (`validate_days` bounds to 365) rather than a tighter number restated here:
# the adapter no longer clamps, so a limit this file invented would be a
# promise nothing keeps. The route CLAMPS rather than refuses, which is why an
# out-of-range value is not an error.
_DAYS_ARG: dict[str, Any] = {
    "type": "integer",
    "description": "Days to look back (default 7). Values above the route's ceiling are clamped, not refused.",
    "default": 7,
    "minimum": 1,
    "maximum": 365,
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
                    # DECLARED, not just described. The sentence below always said
                    # "at least 2 characters" while the schema accepted "a", so a
                    # validating client had nothing to check against and the route
                    # answered a one-character search with `{'count': 0}` and no
                    # error. Both the constraint and the sentence now read from
                    # `SEARCH_QUERY_MIN_LENGTH`, so the prose cannot drift from the
                    # rule the route actually enforces.
                    "minLength": SEARCH_QUERY_MIN_LENGTH,
                    "description": (
                        "Text to match in the verbatim, title or problem summary. "
                        f"Must be at least {SEARCH_QUERY_MIN_LENGTH} characters. "
                        "Omit to list by filters alone."
                    ),
                },
                "days": _DAYS_ARG,
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
                    "description": "Max items to return (default 20). Clamped to the route's ceiling of 100.",
                    "default": 20,
                    "minimum": 1,
                    "maximum": 100,
                },
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "description": "Items returned"},
                "query": {"type": "string", "description": "The text matched, empty when filtering only"},
                # The tool most likely to truncate was the only one that hid it.
                # `get_metrics_breakdown` has always published `is_partial`; this
                # one collected the same flag from the route and threw it away, so
                # `count: 0` could mean "nothing matches in your window" or "the
                # scan stopped before reaching the end of it" and a caller had no
                # way to tell. REQUIRED, because a flag that is sometimes missing
                # is read as absence of truncation — the same mistake as asserting
                # it false.
                "is_partial": {
                    "type": "boolean",
                    "description": (
                        "True when the candidate scan stopped on its soft cap before "
                        "covering the whole window, so results are a sample of it"
                    ),
                },
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _FEEDBACK_SUMMARY_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "query", "is_partial", "items"],
            "additionalProperties": False,
        },
    },
    {
        "name": "get_metrics_summary",
        "description": (
            "Dashboard summary over a time window: total feedback, average sentiment, "
            "urgent count, and the daily totals and sentiment series. "
            "For counts per category, sentiment, source or persona use get_metrics_breakdown."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {**_DAYS_ARG, "description": "Days to aggregate (default 7)."},
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer"},
                "total_feedback": {"type": "integer"},
                "avg_sentiment": {"type": "number", "description": "Weighted mean, -1..1"},
                "urgent_count": {"type": "integer"},
                "daily_totals": {"type": "array", "items": {"type": "object"}},
                "daily_sentiment": {"type": "array", "items": {"type": "object"}},
            },
        },
    },
    {
        "name": "get_metrics_breakdown",
        "description": (
            "Counts along one axis over a time window: sentiment labels, categories, "
            "source platforms, or inferred personas."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "dimension": {
                    "type": "string",
                    "enum": ["sentiment", "categories", "sources", "personas"],
                    "description": "Which axis to break the window down by",
                },
                "days": {**_DAYS_ARG, "description": "Days to aggregate (default 7)."},
            },
            "required": ["dimension"],
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer"},
                "is_partial": {
                    "type": "boolean",
                    "description": "True when an aggregate read failed and counts are incomplete",
                },
                "breakdown": {"type": "object", "description": "Counts, when dimension=sentiment"},
                "percentages": {"type": "object", "description": "Shares, when dimension=sentiment"},
                "categories": {"type": "object", "description": "When dimension=categories"},
                "sources": {"type": "object", "description": "When dimension=sources"},
                "personas": {"type": "object", "description": "When dimension=personas"},
            },
        },
    },
    {
        "name": "get_project",
        "description": (
            "Project metadata with its personas and its documents listed by title. "
            "Documents cover PRDs, PR/FAQs, research reports, uploaded documents, "
            "product reports and prototypes; bodies are not included."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "name": {"type": "string"},
                "description": {"type": "string"},
                "created_at": {"type": "string"},
                "persona_count": {"type": "integer"},
                "document_count": {"type": "integer"},
                "personas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "persona_id": {"type": "string"},
                            "name": {"type": "string"},
                            # `tagline`, not `type`: no stored persona has ever
                            # carried a `type`, so this summary reported an empty
                            # string for every persona in every project.
                            "tagline": {"type": "string"},
                        },
                        "additionalProperties": False,
                    },
                },
                "documents": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "document_id": {"type": "string"},
                            "title": {"type": "string"},
                            "type": {"type": "string"},
                            "kind": {
                                "type": "string",
                                "enum": sorted(set(_DOCUMENT_KINDS.values())) + [""],
                                "description": "Document kind, derived from its storage prefix",
                            },
                        },
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["project_id", "persona_count", "document_count", "personas", "documents"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_personas",
        "description": (
            "List all personas for a project: identity and demographics, goals "
            "and motivations, pain points, behaviors, context and environment, "
            "representative quotes, and scenario. Researcher notes are not "
            "included."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project_id": _PROJECT_ID_ARG,
            },
            "additionalProperties": False,
        },
        "outputSchema": {
            "type": "object",
            "properties": {
                "count": {"type": "integer"},
                "personas": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": _PERSONA_PROPERTIES,
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["count", "personas"],
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
        "outputSchema": {
            "type": "object",
            "properties": _FEEDBACK_DETAIL_PROPERTIES,
            # Every key is always emitted (the projection uses typed defaults),
            # so declaring them costs nothing and lets a client rely on them.
            "required": sorted(_FEEDBACK_DETAIL_PROPERTIES),
            "additionalProperties": False,
        },
    },
]


# ============================================
# MCP Tool implementations
# ============================================

def _row_value(item: dict[str, Any], keys: tuple[str, ...]) -> Any:
    """The first present value among `keys`, or None.

    Presence is "not absent and not empty string" rather than truthiness, so a
    `rating` or `sentiment_score` of 0 counts as present and reports as `'0'`.
    Testing truthiness here would report a zero rating as unrated.
    """
    for key in keys:
        value = item.get(key)
        if value is not None and value != '':
            return value
    return None


def _project_feedback(item: dict, *, summary: bool) -> dict:
    """Reshape one raw feedback record for a model to read.

    The projection is the adapter's job, not the route's: a raw record carries
    pk/sk/gsi keys, enrichment internals and the full verbatim, and a list of 20
    of them would spend a model's context on fields it cannot use. The renames
    (`source_platform`→`source`, `sentiment_label`→`sentiment`,
    `original_text`→`text`) are the names the tools have always reported.

    ONE function for both feedback tools, parameterized by `summary`, because
    they agree on ten fields and differ only in truncation and in the five
    detail-only fields. Two copies is how the pair drifts — which is exactly the
    defect that made delegating worth doing in the first place.

    `sentiment_score` and `rating` are stringified, preserving the existing
    contract: both are DynamoDB Decimals, and a client that pattern-matched on
    `"rating": "N/A"` for an unrated item still sees it.

    Every field is coerced to the type it is DECLARED as, driven by
    `_FEEDBACK_SOURCE_KEYS` and the declarations rather than field by field. The
    version this replaces read each field with `item.get(key, default)`, and a
    default fires only when a key is ABSENT — it cannot correct a value of the
    wrong TYPE. That is the same defect that made `list_personas` uncallable, and
    here it was worse than a schema violation: `date` and `text` are SLICED
    (`[:10]`, `[:_SUMMARY_TEXT_LIMIT]`), so a row storing either as a number or a
    dict raised `TypeError` inside the projection and took down the whole tool
    call. Coercing first makes both slices safe by construction.

    Only `id` and `rating` keep behaviour that the declarations cannot express:
    `id` falls back across two row keys, and an absent `rating` reports the
    documented `'N/A'` rather than an empty string.
    """
    # `feedback_id` FIRST, and this is a bug fix rather than a rename.
    #
    # Both feedback tools reported `item.get('id')`, and the processor that
    # writes these rows never sets a plain `id` — the identifier is
    # `feedback_id`, which is also the key `GET /feedback/{id}` looks up on its
    # GSI. So `search_feedback` advertised an `id` field and filled it with `""`
    # for every item in the corpus, which made `get_feedback_detail` unreachable
    # for an agent: the only way to learn a feedback id is to search, and search
    # reported none. Verified live against the deployed API before fixing.
    declared = _FEEDBACK_SUMMARY_TYPES if summary else _FEEDBACK_DETAIL_TYPES
    projected = {
        # `.get(key, (key,))` rather than `[key]`: a declared property with no
        # entry in the map reads the row key of its own name instead of raising
        # `KeyError` and killing the tool call — the M1 failure mode. The
        # omission is still a CI failure, pinned by
        # `test_source_key_map_covers_every_declared_field`; this only decides
        # whether the symptom is a red test or a dead tool in production.
        key: _coerce_declared(_row_value(item, _FEEDBACK_SOURCE_KEYS.get(key, (key,))), declared_type)
        for key, declared_type in declared.items()
    }
    # An unrated item reads `'N/A'`, not `''`. Applied after coercion so a stored
    # `None` reports `'N/A'` too — `str(None)` used to put the literal `'None'`
    # in front of a model, which reads as a value rather than as an absence.
    if not projected["rating"]:
        projected["rating"] = 'N/A'
    if summary:
        # A list answer carries the date as a plain day and clips the verbatim;
        # the single-item answer carries both in full.
        projected["date"] = projected["date"][:10]
        projected["text"] = projected["text"][:_SUMMARY_TEXT_LIMIT]
    return projected


@tracer.capture_method
def _tool_search_feedback(args: dict, token_info: dict) -> ToolResult:
    """Search feedback, via the route that owns the corpus.

    TWO routes behind one tool, chosen by whether a `query` was given, because
    that is what this tool has always done: `GET /feedback/search` is a text
    search and REFUSES a query shorter than two characters, while the filters
    alone (no text) are what `GET /feedback` answers. Mapping the tool onto
    `/feedback/search` alone would have made every filter-only call return
    nothing; splitting it into two tools is Phase 3's `list_feedback`.
    """
    query = args.get('query')
    query = query.strip() if isinstance(query, str) else ''
    shared_filters = {
        'days': args.get('days', 7),
        'limit': args.get('limit', 20),
        'category': args.get('category'),
        'sentiment': args.get('sentiment'),
        'source': args.get('source'),
        'date_basis': args.get('date_basis'),
    }

    if query:
        call = _domain_call('feedback_search', query={'q': query, **shared_filters})
    else:
        call = _domain_call('feedback_list', query=shared_filters)

    body = _delegate(call, token_info).payload
    raw_items = body.get('items', []) if isinstance(body, dict) else []
    # Projected FIRST, then counted, so `count` describes what the caller
    # received. Counting the route's list instead would let a non-dict entry make
    # `count` exceed `len(items)` in the same payload.
    items = [_project_feedback(item, summary=True) for item in raw_items
             if isinstance(item, dict)]
    # Both routes publish the flag under the same name, so one read covers the
    # search branch and the filter-only branch. Coerced with `bool()` rather than
    # passed through: the declaration says boolean, and a route that answered
    # `null` would otherwise reproduce M1 in the field added to fix M5.
    truncated = bool(body.get('is_partial_window')) if isinstance(body, dict) else False
    return ToolResult({
        "count": len(items),
        "query": query,
        "is_partial": truncated,
        "items": items,
    })


@tracer.capture_method
def _tool_get_metrics_summary(args: dict, token_info: dict) -> ToolResult:
    """Dashboard summary metrics, from the route the dashboard itself uses.

    ⚠️ The answer's SHAPE changed at server 2.0.0, and not only by field names.
    This tool used to recompute the summary from raw aggregate rows and reported
    `sentiment_breakdown` + `top_categories`; the route reports `avg_sentiment`,
    `urgent_count` and the daily series instead. The counts per sentiment and
    per category now come from `get_metrics_breakdown`, which is why that tool
    is in this phase rather than the next one — between them the two tools
    report strictly more than the old one did, so no client loses information.

    The window-clamping helper this used to need is gone with it: `days` is
    bounded by the route's own `validate_days`, which is a validator documented
    never to raise (it clamps and defaults), so a nonsense window degrades the
    same way it does for every other caller of that route instead of the way
    one hand-written clamp in this file happened to.
    """
    body = _delegate(
        _domain_call('metrics_summary', query={'days': args.get('days', 7)}),
        token_info,
    ).payload
    return ToolResult(body if isinstance(body, dict) else {})


# The four breakdown routes, as the `dimension` argument names them. One tool
# over four routes: they answer the same question about different axes, and four
# near-identical tool declarations would spend a model's context to say so.
_BREAKDOWN_DIMENSIONS: dict[str, str] = {
    'sentiment': '/metrics/sentiment',
    'categories': '/metrics/categories',
    'sources': '/metrics/sources',
    'personas': '/metrics/personas',
}


@tracer.capture_method
def _tool_get_metrics_breakdown(args: dict, token_info: dict) -> ToolResult:
    """Counts along one axis: sentiment, categories, sources or personas.

    Passed through unprojected, deliberately: each of these routes answers with
    a small `{period_days, is_partial, <axis>: {...}}` object that is already
    exactly what a model needs, and re-shaping it here would reintroduce the
    second implementation that delegating exists to remove. It also carries the
    routes' own `is_partial`, so a degraded aggregate read is still reported.
    """
    dimension = args.get('dimension')
    if dimension not in _BREAKDOWN_DIMENSIONS:
        # A -32602 rather than a delegated 404: the enum is this tool's own
        # contract, so an unknown value is a malformed call, not a route refusal.
        raise InvalidToolArgument(
            f"dimension must be one of: {', '.join(sorted(_BREAKDOWN_DIMENSIONS))}"
        )
    body = _delegate(
        _domain_call(f'metrics_{dimension}', query={'days': args.get('days', 7)}),
        token_info,
    ).payload
    return ToolResult(body if isinstance(body, dict) else {})


def _document_kind(item: dict) -> str:
    sk = item.get('sk', '')
    for prefix, kind in _DOCUMENT_KINDS.items():
        if sk.startswith(prefix):
            return kind
    return ''


def _as_string(value: Any) -> str:
    """Coerce a declared-string persona field to the string it promises.

    A list is joined rather than passed through: `emotional_impact` and
    `primary_goal` are declared strings, and a list arriving in either would
    reproduce the defect this schema fix is about — a payload contradicting its
    own declaration. A dict becomes JSON rather than a Python `repr`, because
    the reader is a model and `{'a': 'x'}` is not machine-readable.
    """
    if value is None:
        return ''
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return '; '.join(_as_string(v) for v in value if v not in (None, ''))
    if isinstance(value, dict):
        return json.dumps(value, cls=DecimalEncoder)
    return str(value)


def _as_int(value: Any) -> int:
    """Coerce a declared-integer persona field, defaulting rather than lying.

    `feedback_count` arrives from DynamoDB as a `Decimal`, and not at all on
    rows that predate it. An unparseable value becomes 0 instead of travelling
    as the string it was.
    """
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _as_string_list(value: Any) -> list[str]:
    """Coerce a declared-array persona field to the list of strings it promises.

    A writer that leaves a single value unwrapped (`workarounds` is a string on
    some imported rows and a list on generated ones) must not make the payload
    contradict its own schema, so the boundary coerces instead of passing the
    scalar through. Non-string entries are stringified rather than dropped: the
    value is a model's evidence, and silently losing it is worse than reporting
    it in the declared type.
    """
    if value is None or value == '':
        return []
    if isinstance(value, (list, tuple)):
        return [_as_string(v) for v in value if v not in (None, '')]
    return [_as_string(value)]


# One coercion per JSON type the persona schema declares. Objects are absent on
# purpose: the sections and quotes have their own projections, which is also why
# `_PERSONA_SCALAR_TYPES` excludes them.
_COERCIONS: dict[str, Callable[[Any], Any]] = {
    "string": _as_string,
    "integer": _as_int,
    "array": _as_string_list,
}


def _coerce_declared(value: Any, declared_type: str) -> Any:
    """Coerce one value to the JSON type its own schema declares.

    A type with no coercion passes through unchanged, so an undeclared key keeps
    whatever the row holds — `additionalProperties: true` permits it and
    rewriting it would claim a structure the row does not have.
    """
    coerce = _COERCIONS.get(declared_type)
    return coerce(value) if coerce else value


def _persona_section(name: str, value: Any, declared: dict[str, str]) -> dict:
    """One canonical persona section, coerced to its declared types.

    Unrecognised keys are PRESERVED, not dropped. The section's declared keys
    are what the prompts pin; a prompt is a request, so real rows also carry
    `primary_frustration`, `tooling`, `related_issues`. Dropping those would
    make the tool answer "this persona has no pain points" about a persona whose
    pain points are simply under a key this file did not predict — the same
    class of silent under-report the surface is being fixed for.
    """
    if not isinstance(value, dict):
        # Absent, or a shape no writer produces. Both writers persist an object
        # (both default to `{}`) and all five live rows are objects, so there is
        # no flat-list case to salvage — and guessing a destination key would
        # file content under a misleading heading (`sorted()` would pick
        # `blockers` for a list of pain points). An absent section is normal and
        # silent; anything else is logged, because a section that cannot be
        # reported should be visible rather than invisible. The value itself is
        # never logged: it is customer-derived text.
        if value not in (None, '', [], {}):
            logger.warning(
                "Persona section not reported: not an object",
                extra={"section": name, "arrived_as": type(value).__name__},
            )
        return {}
    return {
        key: _coerce_declared(inner, declared[key]) if key in declared else inner
        for key, inner in value.items()
    }


def _as_quote(value: Any) -> dict | None:
    """One representative quote, as the object the schema declares.

    A bare string entry used to be filtered out, which answered "this persona
    has no quotes" about a persona who had them — the same silent under-report
    this file argues against everywhere else. These entries are LLM-authored on
    a path that pinned nothing until now, so `quotes: ["…"]` is a plausible
    stored shape and it becomes `{"text": …}`. `None` means the entry carried no
    content, not that content was discarded.
    """
    if isinstance(value, dict):
        return {
            key: _coerce_declared(inner, _QUOTE_TYPES[key]) if key in _QUOTE_TYPES else inner
            for key, inner in value.items()
        }
    text = _as_string(value)
    return {"text": text} if text else None


def _project_persona(item: dict) -> dict:
    """One persona in the canonical shape of `schemas/persona.schema.json`.

    Used ONLY by `list_personas`. `get_project` deliberately renders a two-field
    summary of its own — an earlier version of this docstring claimed the two
    shared a projection, which was never true and is why the schema mismatch
    went unnoticed for so long.

    Every field is coerced to the type it is DECLARED as, driven by the
    declarations rather than written out field by field. The bug this replaces
    read each field with `item.get(key, default)`, and a default fires only when
    a key is ABSENT: it cannot correct a value of the wrong TYPE, so the object
    `pain_points` travelled unchanged under a schema declaring `array<string>`
    and a validating client rejected the whole result. Driving it from the
    declarations is the second half of that lesson — the field-by-field version
    of this function guarded `feedback_count` and left `confidence` unchecked.

    Everything not declared — avatar keys, source feedback ids, researcher
    notes, timestamps, llm metadata — is still dropped: a project's personas are
    the answer, not its storage layout.
    """
    projected: dict[str, Any] = {
        key: _coerce_declared(item.get(key), declared_type)
        for key, declared_type in _PERSONA_SCALAR_TYPES.items()
    }
    for section, declared in _PERSONA_SECTION_TYPES.items():
        projected[section] = _persona_section(section, item.get(section), declared)

    quotes = item.get('quotes')
    entries = quotes if isinstance(quotes, (list, tuple)) else [quotes]
    projected["quotes"] = [q for q in map(_as_quote, entries) if q is not None]
    return projected


def _get_project_payload(token_info: dict) -> tuple[dict, list[dict], list[dict]]:
    """Fetch one project from the route that owns it.

    `project_id` is the project `_handle_tools_call` resolved from the arguments
    (or the token's single project) AND authorized against the token's read
    reach. It is not "the token's project" — a credential can reach several — so
    it must not be re-derived here.
    """
    project_id = token_info['project_id']
    body = _delegate(
        _domain_call('project_get', path_parameters={'project_id': project_id}),
        token_info,
    ).payload
    if not isinstance(body, dict):
        raise DelegationUnavailable('project route returned no object')
    meta = body.get('project')
    personas = body.get('personas') or []
    documents = body.get('documents') or []
    return (
        meta if isinstance(meta, dict) else {},
        [p for p in personas if isinstance(p, dict)],
        [d for d in documents if isinstance(d, dict)],
    )


@tracer.capture_method
def _tool_get_project(args: dict, token_info: dict) -> ToolResult:
    """Project metadata with its personas and documents listed by name.

    Documents are listed, never inlined: a generated prototype is hundreds of
    kilobytes and a PRD is thousands of words, so returning bodies here would
    blow both the model's context and the 6 MB synchronous-invoke ceiling.
    Bodies become resources in a later phase.
    """
    meta, personas, documents = _get_project_payload(token_info)
    # Every field below is declared a string in this tool's own `outputSchema`, so
    # every one is coerced. `.get(key, '')` defaults on an ABSENT key and cannot
    # correct a value of the wrong TYPE — the mechanism behind `list_personas`
    # being uncallable, and this tool reports a persona `tagline` from the same
    # LLM-authored rows. Well-formed rows are unaffected: `_as_string` returns a
    # string unchanged.
    return ToolResult({
        "project_id": token_info['project_id'],
        "name": _as_string(meta.get('name')),
        "description": _as_string(meta.get('description')),
        "created_at": _as_string(meta.get('created_at')),
        "persona_count": len(personas),
        "document_count": len(documents),
        "personas": [
            {"persona_id": _as_string(p.get('persona_id')), "name": _as_string(p.get('name')),
             "tagline": _as_string(p.get('tagline'))}
            for p in personas
        ],
        "documents": [
            {"document_id": _as_string(d.get('document_id')), "title": _as_string(d.get('title')),
             "type": _as_string(d.get('type')), "kind": _document_kind(d)}
            for d in documents
        ],
    })


@tracer.capture_method
def _tool_list_personas(args: dict, token_info: dict) -> ToolResult:
    """Every persona for a project, in full.

    Derived from the same project route rather than from a personas-only read:
    there is no such route, and inventing a second path to the same rows is what
    delegating exists to avoid. The cost is reading the project's documents to
    discard them, which is one Query either way.
    """
    _meta, personas, _documents = _get_project_payload(token_info)
    return ToolResult({
        "count": len(personas),
        "personas": [_project_persona(p) for p in personas],
    })


@tracer.capture_method
def _tool_get_feedback_detail(args: dict, token_info: dict) -> ToolResult:
    """One feedback item in full, by id.

    A missing item is now the route's 404 arriving as a tool ERROR rather than
    the prose "not found" inside a successful result this tool used to return.
    That is the point of the change: a model reading `isError: false` has been
    told the call worked, so it treats the prose as data and reports the item as
    empty rather than retrying with a different id.
    """
    feedback_id = args.get('feedback_id')
    if not isinstance(feedback_id, str) or not feedback_id.strip():
        raise InvalidToolArgument('feedback_id must be a non-empty string')

    body = _delegate(
        _domain_call('feedback_item',
                     path_parameters={'feedback_id': feedback_id.strip()}),
        token_info,
    ).payload
    if not isinstance(body, dict):
        raise DelegationUnavailable('feedback route returned no object')
    return ToolResult(_project_feedback(body, summary=False))


# Tool name → implementation mapping
TOOL_HANDLERS = {
    "search_feedback": _tool_search_feedback,
    "get_feedback_detail": _tool_get_feedback_detail,
    "get_metrics_summary": _tool_get_metrics_summary,
    "get_metrics_breakdown": _tool_get_metrics_breakdown,
    "get_project": _tool_get_project,
    "list_personas": _tool_list_personas,
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
    "get_metrics_breakdown": SCOPE_METRICS_READ,
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
    "get_metrics_breakdown": REACH_KIND_WORKSPACE,
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
            "version": MCP_SERVER_VERSION,
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


class InvalidToolArgument(Exception):
    """A tool argument is malformed on the tool's OWN terms.

    Reported as `-32602 Invalid params` and never delegated, which is the line
    worth keeping straight: a value the tool's `inputSchema` forbids (an unknown
    enum member, a `project_id` that is not a string) is a malformed request,
    while a well-formed value the DATA refuses (a project that does not exist)
    is the route's 404 and arrives as a tool error the model can act on. Sending
    the first kind downstream would turn a client bug into a domain lookup.
    """


class InvalidProjectArgument(InvalidToolArgument):
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

    # An explicit `"arguments": null` means "no arguments", not "bad request".
    # `params.get('arguments', {})` cannot supply the default for it, because the
    # KEY IS PRESENT — and some JSON-RPC/MCP clients serialize an omitted
    # optional object as null rather than dropping it. Every tool here has only
    # optional arguments, so `{}` is exactly what such a caller meant; refusing
    # it would be a compatibility edge invented by this guard rather than a real
    # protocol error.
    if arguments is None:
        arguments = {}

    # Anything else non-object is genuinely malformed. A list, string or number
    # reaches the project resolution below, where both `'project_id' in args` and
    # `args['project_id']` raise TypeError — and that resolution runs OUTSIDE the
    # try/except around the handler, so it escapes as a 502 with no JSON-RPC
    # envelope and no CORS headers. Refused here at the boundary, which is the
    # same lesson the BotoCoreError clause in _authenticate records: an unhandled
    # type is a protocol-level error, not a server crash.
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

    # The three outcomes are separated because the MCP spec separates them, and
    # the distinction is what lets a model behave sensibly:
    #
    #   malformed call        → JSON-RPC error   (-32602) — the client is wrong
    #   route refused a call  → RESULT isError   — the model can try something else
    #   infrastructure fault  → JSON-RPC error   (-32603) — nobody upstream can fix it
    #
    # Collapsing the middle case into the first would tell a model its request
    # was malformed when it was merely unlucky; collapsing it into a successful
    # result (what this handler used to do for "not found") tells the model the
    # call worked and the data is empty, which it then reports as fact.
    try:
        result = handler(arguments, token_info)
    except InvalidToolArgument as exc:
        return _jsonrpc_error(req_id, -32602, str(exc))
    except ToolRouteError as exc:
        return _tool_error(req_id, str(exc))
    except DelegationUnavailable:
        # Already logged with the route and fault type at the point of failure.
        # The client is told only that the server failed: the detail is a
        # function name, a status code or a stack trace, none of which is the
        # caller's business and one of which is a fingerprint of the topology.
        logger.error("Delegation failed", extra={"tool": tool_name})
        return _jsonrpc_error(req_id, -32603, "Internal error: upstream service unavailable")
    except Exception as e:
        logger.exception(f"Tool execution error: {tool_name}")
        return _tool_error(req_id, f"Error: {str(e)}")

    return _jsonrpc_result(req_id, {
        "content": [{"type": "text", "text": result.text}],
        # Structured output alongside the text block, not instead of it: the
        # spec says a tool SHOULD keep sending the serialized form for clients
        # that predate `structuredContent`, and both come from one value here so
        # they cannot disagree.
        "structuredContent": result.structured,
        "isError": False,
    })


def _tool_error(req_id: Any, message: str) -> dict:
    """A tool EXECUTION error: a successful JSON-RPC call reporting a failure."""
    return _jsonrpc_result(req_id, {
        "content": [{"type": "text", "text": message}],
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

    # Delegated like every tool, and this one is why the projects-table grant
    # could be narrowed to the token partition: autoseed was the last reader of
    # project ARTIFACT rows in this function. The filter arguments are passed
    # through as the route's own query string rather than re-parsed here — the
    # comma-splitting used to be duplicated in both places.
    query_params = event.get('queryStringParameters') or {}
    # ONE try around both steps, because both can raise both kinds. Building the
    # call can fail on a malformed path parameter (400 — the credential is fine
    # and the path is not) OR on a missing reserved-segment declaration, which is
    # a server fault and belongs with the delegation failure below. Two separate
    # try blocks let the second kind escape from the first step to the outer
    # catch-all, answering something other than the 502 this route establishes.
    try:
        call = _domain_call('project_autoseed', path_parameters={'project_id': project_id}, query={
            'persona_ids': query_params.get('persona_ids'),
            'document_ids': query_params.get('document_ids'),
        })
        result = call_domain(call, claims=synthetic_claims(token_info))
    except InvalidToolArgument as exc:
        return _cors_response({'message': str(exc)}, status_code=400)
    except DelegationUnavailable:
        logger.error('Autoseed delegation failed', extra={'project_id': project_id})
        return _cors_response({'message': 'Upstream service unavailable'}, status_code=502)
    # The route's own status travels with its body: a 404 for an unknown project
    # stays a 404 here instead of becoming the 500 this used to answer for it.
    #
    # An empty upstream body becomes `{}` rather than `null`: this route's clients
    # read fields off the response, and `null` makes that a TypeError where `{}`
    # makes it a missing key.
    return _cors_response(result.payload if result.payload is not None else {},
                          status_code=result.status_code)


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
