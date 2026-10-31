"""
Shared API utilities for VoC Lambda functions.
Provides common helpers, encoders, validators, and decorators.
"""

import json
import os
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig, Response, content_types

from shared import http_cache
from shared.app_clients import require_app_client
from shared.category_override import redact_category_overrides
from shared.e2e_tag import with_test_run_tag
from shared.earliest_date import parse_iso_date
from shared.exceptions import (
    ApiError,
    AuthenticationError,
    AuthorizationError,
    ConfigurationError,
    ConflictError,
    NotFoundError,
    PayloadTooLargeError,
    ServiceError,
    TooManyRequestsError,
    ValidationError,
)

# Date-basis values live in shared.feedback (the data layer) so job Lambdas
# don't import API-resolver machinery for constants; re-exported here for
# API handlers and backward compatibility.
from shared.feedback import (  # noqa: F401 — re-export
    DATE_BASIS_IMPORTED,
    DATE_BASIS_REVIEW,
    VALID_DATE_BASES,
    validate_date_basis,
)
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger, metrics, tracer
from shared.model_profile import profile_for_groups, profile_from_job_event, with_model_profile
from shared.project_access import ADMIN_GROUP


def decimal_default(obj):
    """JSON serializer for Decimal types.

    Use with json.dumps: json.dumps(data, default=decimal_default)
    """
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


# The most personas one generation may produce. Lives here rather than beside
# validate_persona_count because two other places size themselves against it: the avatar
# fan-out's max_workers and the image-model client's connection pool. Those were
# independent literals whose only link was a comment, and a comment cannot fail CI — so
# raising this ceiling used to silently halve the fan-out benefit while every test passed.
MAX_PERSONAS_PER_GENERATION = 10

# The shortest text search `/feedback/search` will run. Lives here, beside
# MAX_PERSONAS_PER_GENERATION and for the same reason, because THREE places size
# themselves against it and two of them are in other files: the route that
# enforces it, the MCP tool's `inputSchema.minLength` plus the sentence in its
# description that states it, and the frontend's own `FEEDBACK_SEARCH_MIN_CHARS`
# gate (`api/feedbackSearch.ts`).
#
# 🔑 The bound was previously the bare literal `2` in the route and a claim in
# English in the MCP tool description, with nothing declaring it — so the tool
# advertised "must be at least 2 characters" while its schema accepted `"a"`, the
# route answered `{'count': 0}` to it, and a model read that as "no customer
# mentioned this". A prose promise cannot fail CI.
SEARCH_QUERY_MIN_LENGTH = 2

# The longest window any route will honour, and `validate_days`' ceiling.
#
# Nothing is ever deleted (feedback items and aggregate rows carry no TTL), so the
# ceiling is a sanity bound on the integer rather than a retention horizon: ~27
# years. The frontend's `MAX_CUSTOM_DAYS` and the stream contract's maximum are
# the same number (`frontend/src/api/daysWindow.lockstep.test.ts` pins all three).
#
# It no longer bounds a request's DURATION: per-day `gsi1-by-date` walks are cut by
# the wall-clock budget in `shared/time_budget.py` instead, and the responses say so
# (`partial_reason: 'time_budget'`). `api-stack.test.ts` pins THAT budget against the
# metrics Lambda timeout.
MAX_FEEDBACK_WINDOW_DAYS = 9999

# `days=0` means "all time": from the earliest-data watermark to today.
ALL_TIME_DAYS = 0

# What `days=0` resolves to when no watermark exists yet (a deployment that has not
# ingested since the watermark was introduced and has not run
# `scripts/retention/remove_ttl.py --apply`): one year, the widest window the
# routes served before all-time windows existed.
ALL_TIME_FALLBACK_DAYS = 365


def validate_days(
    value: str | int | None,
    default: int = 7,
    min_val: int = ALL_TIME_DAYS,
    max_val: int = MAX_FEEDBACK_WINDOW_DAYS
) -> int:
    """Validate and bound a `days` parameter: 0 (all time) through MAX_FEEDBACK_WINDOW_DAYS.

    A 0 is returned as 0 — callers that walk or sum a window must resolve it to a
    concrete day count with `effective_window_days`.
    """
    return validate_int(value, default=default, min_val=min_val, max_val=max_val)


def effective_window_days(days: int, earliest_date: str | None, today: date) -> int:
    """The concrete number of days a `days` request covers, given the data's history.

    * With a watermark: `0` (all time) and any window reaching past the earliest data
      both become "days since `earliest_date`, inclusive" (at least 1), so an all-time
      request walks exactly the history and no further. Shorter windows are unchanged.
    * Without one (absent or malformed): `days` as given, and `0` falls back to
      `ALL_TIME_FALLBACK_DAYS` — the history length is unknown, so a year is served.

    Never more than MAX_FEEDBACK_WINDOW_DAYS, so a corrupt watermark cannot make
    a window loop unbounded.
    """
    earliest = parse_iso_date(earliest_date)
    if earliest is None:
        return days if days > ALL_TIME_DAYS else ALL_TIME_FALLBACK_DAYS
    history = min(max((today - earliest).days + 1, 1), MAX_FEEDBACK_WINDOW_DAYS)
    return history if days <= ALL_TIME_DAYS else min(days, history)


def requested_window_cutoff(days: int, today: date) -> str:
    """The oldest YYYY-MM-DD a REQUESTED `days` window admits on a basis date; '' for all time.

    `effective_window_days` clamps a window to the import history, which is right for
    WALKING the import-date index (no review is imported before it was written, so the
    clamped import window still holds every review written in the requested window).
    It is wrong as a REVIEW-date cutoff: reviews imported yesterday but written months
    earlier would all fall before "the first import day" and vanish. The basis-date
    filter therefore uses this cutoff, computed from the days the caller asked for:
    none at all for all time (0), else the first day of a `days`-long window ending today.
    """
    if days <= ALL_TIME_DAYS:
        return ''
    return (today - timedelta(days=days - 1)).isoformat()


def validate_limit(
    value: str | int | None,
    default: int = 50,
    min_val: int = 1,
    max_val: int = 100
) -> int:
    """Validate and bound limit parameter. Convenience wrapper around validate_int."""
    return validate_int(value, default=default, min_val=min_val, max_val=max_val)


def validate_int(
    value: str | int | None,
    default: int,
    min_val: int = 1,
    max_val: int = 100
) -> int:
    """Generic integer validation with bounds.

    Returns ``default`` for ``None`` and for anything ``int()`` cannot read, and
    otherwise clamps into ``[min_val, max_val]``. So the contract is "always a
    bounded int, never a raise", which is what every caller relies on.

    ``OverflowError`` is caught alongside ``ValueError``/``TypeError`` because
    ``int(float('inf'))`` raises it, and a non-finite float is reachable wherever a
    request body is parsed: ``json.loads`` is non-strict by default and accepts the
    ``Infinity``/``-Infinity``/``NaN`` literals. Without it the fallback simply did
    not happen for that one input — the exception propagated out of a validator
    documented never to raise, which in a multi-write handler surfaced as a 500
    part way through the work.

    Two things a caller must know, because this cannot decide them here:

    * A ``bool`` is COERCED, not refused: ``isinstance(True, int)`` is true and
      ``int(True)`` is ``1``. Harmless where the result is a page size, wrong where
      it is a value a human is said to have chosen — a flag is not a slider
      position. A caller in the second case must refuse ``bool`` itself, before
      calling this (``validate_bool`` makes the mirror argument). Named as a
      requirement on callers rather than by pointing at one: a shared helper citing
      a particular handler's PRIVATE predicate reads as a dependency it does not
      have, and goes stale the moment that handler renames it.
    * ``default`` is returned for input this could not read, so it is not merely a
      value for "absent" — it is also the value for "unreadable". Where the two
      must be distinguishable, or where the default would read as a deliberate
      choice, check the value before calling rather than reading meaning into what
      comes back.
    """
    try:
        val = int(value) if value is not None else default
        return max(min_val, min(val, max_val))
    except (ValueError, TypeError, OverflowError):
        return default


def validate_bool(value: object, default: bool, field: str = 'value') -> bool:
    """Validate a boolean request field, refusing anything that is not a real bool.

    The other validators here clamp or fall back, which is right for a number whose
    worst case is a bounded value. A boolean has no such middle: coercing an unexpected
    value picks one of the two behaviours silently, and for a flag that gates billed work
    the wrong pick costs money in the direction the caller did not ask for. ``"false"``
    from a form post or an over-eager serialiser is the realistic case.

    Absent (``None``) yields ``default`` — an omitted field must keep behaving as it did
    before the field existed. Note this treats an explicit JSON ``null`` as absent, since
    ``dict.get`` cannot distinguish the two; that is deliberate and harmless, because both
    mean "the caller expressed no preference".

    Raises:
        ValidationError: for any non-boolean value, which the API resolver maps to a 400.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    # Type name only, not the value: the type is the diagnostic ("you sent a string"),
    # while the value is unbounded caller input and echoing it into a response body buys
    # nothing the caller does not already have.
    raise ValidationError(
        f'{field} must be true or false, got {type(value).__name__}'
    )


def get_caller_groups(event: dict) -> list[str]:
    """Extract Cognito group memberships from the API Gateway authorizer claims.

    Handles every format API Gateway emits for the ``cognito:groups`` claim:
    a real list, and strings that are comma- or space-separated — including
    the REST-authorizer serialization of the array claim as a
    bracket-wrapped string (``"[admins]"`` / ``"[admins, users]"``).
    """
    try:
        claims = event.get('requestContext', {}).get('authorizer', {}).get('claims', {})
        groups = claims.get('cognito:groups', '')
        if not groups:
            return []
        if isinstance(groups, list):
            return groups
        # REST API Gateway serializes array claims like "[admins, users]".
        cleaned = groups.strip().removeprefix('[').removesuffix(']').strip()
        if not cleaned:
            return []
        if ',' in cleaned:
            return [g.strip() for g in cleaned.split(',')]
        return cleaned.split(' ') if ' ' in cleaned else [cleaned]
    except (AttributeError, TypeError):
        # Only dict/str operations above: a malformed event or claim shape
        # (non-dict level, non-string groups) surfaces as one of these.
        return []


def get_caller_subject(event: dict) -> str:
    """Return the Cognito subject (``sub``) for the authenticated caller.

    The ``sub`` claim is the stable, immutable identifier assigned by Cognito
    at user-creation time.  Unlike a username (which can be reused) or an
    email (which can change), it never refers to a different person.

    The returned value identifies a person and must not be logged.

    Raises:
        AuthorizationError: If the ``sub`` claim is absent or empty.  These
            routes are protected by the Cognito authorizer, so an absent claim
            indicates misconfiguration rather than an anonymous request — the
            handler must fail closed rather than fall back to a shared key.
    """
    request_context = event.get('requestContext')
    authorizer = request_context.get('authorizer') if isinstance(request_context, dict) else None
    claims = authorizer.get('claims', {}) if isinstance(authorizer, dict) else {}
    raw_sub = claims.get('sub') if isinstance(claims, dict) else None
    sub = raw_sub.strip() if isinstance(raw_sub, str) else ''
    if sub:
        return sub
    raise AuthorizationError('Caller identity could not be determined')


def is_admin(event: dict) -> bool:
    """Whether the caller is in the admins group (Cognito authorizer claims)."""
    return ADMIN_GROUP in get_caller_groups(event)


def require_admin(event: dict) -> None:
    """Raise AuthorizationError (403) unless the caller is in the admins group.

    The Cognito authorizer only proves authentication; org-wide mutations
    (user administration, AI model selection) must also check the group.
    """
    if not is_admin(event):
        raise AuthorizationError('Admin access required')


def admins_only(app: APIGatewayRestResolver, next_middleware: Callable[[APIGatewayRestResolver], Any]) -> Any:
    """Resolver middleware: every route of the module that installs it is admin-only (403 otherwise).

    ``app.use(middlewares=[admins_only])`` gates a whole module, so a route added later is gated without having
    to remember the check (the data explorer, manual import and S3 import handlers; owner decision 2026-10-08).
    """
    require_admin(app.current_event.raw_event)
    return next_middleware(app)


def create_cors_config(allowed_origin: str | None = None) -> CORSConfig:
    """
    Create standard CORS configuration for API Gateway.

    Args:
        allowed_origin: Override origin, defaults to ALLOWED_ORIGIN env var

    Returns:
        Configured CORSConfig instance
    """
    origin = allowed_origin or os.environ.get("ALLOWED_ORIGIN", "http://localhost:5173")
    return CORSConfig(
        allow_origin=origin,
        allow_headers=[
            "Content-Type",
            "Authorization",
            "X-Requested-With",
            "X-Amz-Date",
            "X-Api-Key",
            "X-Amz-Security-Token",
        ],
        expose_headers=["Content-Type", "ETag"],
        max_age=300,
        allow_credentials=False,
    )


class CachingRestResolver(APIGatewayRestResolver):
    """The REST resolver plus HTTP revalidation of GET answers (``shared.http_cache``).

    Applied to the finished proxy response, so the ETag hashes the exact body sent
    and a matching ``If-None-Match`` becomes a bodiless 304 (docs/caching.md).
    """

    def resolve(self, event: Mapping[str, Any], context: Any) -> dict[str, Any]:
        response = super().resolve(event, context)
        http_cache.apply(event, response)
        return response


def create_api_resolver(allowed_origin: str | None = None) -> APIGatewayRestResolver:
    """
    Create pre-configured API Gateway resolver with standard CORS and exception handlers.

    Args:
        allowed_origin: Override origin, defaults to ALLOWED_ORIGIN env var

    Returns:
        Configured APIGatewayRestResolver instance with exception handlers registered
        and GET answers tagged for revalidation (ETag / 304, ``shared.http_cache``)
    """
    cors_config = create_cors_config(allowed_origin)
    app = CachingRestResolver(cors=cors_config, enable_validation=True)

    # Register exception handlers for consistent error responses
    _register_exception_handlers(app)
    app.use(middlewares=[_app_clients_only, _redact_response_overrides])

    return app


def _app_clients_only(app: APIGatewayRestResolver, next_middleware):
    """401 for a Cognito token issued to any app client but the SPA's / board's (``shared.app_clients``)."""
    require_app_client(app.current_event.raw_event)
    return next_middleware(app)


def _redact_response_overrides(app: APIGatewayRestResolver, next_middleware):
    """Strip ``category_override.by_sub`` from every JSON body this API returns.

    See ``shared.category_override``: one choke point for every route, so a raw
    feedback item can never carry the editor's Cognito subject to a client.
    """
    response = next_middleware(app)
    if isinstance(response, Response) and isinstance(response.body, (dict, list)):
        response.body = redact_category_overrides(response.body)
    return response


def _register_exception_handlers(app: APIGatewayRestResolver) -> None:
    """
    Register exception handlers for all custom API exceptions.

    This ensures all API errors return a consistent format:
    {
        "success": false,
        "error": "Human-readable error message"
    }

    Log levels: every 4xx the API answers on purpose (400, 403, 404, 409, 413, 429) is the
    API working as designed, so it is logged at INFO and WARNING stays meaningful for
    operators (System -> Logs lists WARNING lines). A refused authorization ("Admin access
    required", "You do not have permission to ...") is one of them: the caller's role or
    project access decided the answer, nothing failed. The access log still records every
    403 per request. Server faults (5xx) are ERROR.
    """
    for exception_type, status_code, log_level, label, both_keys in _EXCEPTION_ANSWERS:
        app.exception_handler(exception_type)(_exception_answer(status_code, log_level, label, both_keys))


# (exception, HTTP status, logger method, log prefix, the body also carries `message`).
# Powertools picks a handler by walking the raised type's ``__mro__``, so ApiError, the
# catch-all, answers with the exception's own ``status_code`` (None below) for any
# subclass not listed.
_EXCEPTION_ANSWERS: tuple[tuple[type[ApiError], int | None, str, str, bool], ...] = (
    (ValidationError, 400, 'info', 'Validation error', False),
    (NotFoundError, 404, 'info', 'Not found', False),
    # Intentionally covers the SecretUnreadableError SUBCLASS too, with no handler
    # of its own: Powertools resolves a handler by walking `exp_type.__mro__`, and
    # the HTTP answer is the same 500 — only callers that must decide whether to
    # COUNT the failure (see BaseIngestor._report_construction_failure) care which
    # of the two it is.
    (ConfigurationError, 500, 'error', 'Configuration error', False),
    (ServiceError, 500, 'exception', 'Service error', False),
    # An expected refusal (role / project access), not a fault: INFO, like every 4xx above.
    (AuthorizationError, 403, 'info', 'Authorization error', False),
    # A token of a foreign app client (an MCP OAuth client): refused like the authorizer would.
    (AuthenticationError, 401, 'info', 'Authentication error', False),
    (ConflictError, 409, 'info', 'Conflict error', False),
    # A client-side sizing problem, not a fault: logged at INFO (no stack
    # trace) and answered with BOTH keys, because callers parse `error ?? message`.
    (PayloadTooLargeError, 413, 'info', 'Payload too large', True),
    # A configured quota (the participant daily send cap): the caller's answer, not a fault.
    (TooManyRequestsError, 429, 'info', 'Quota reached', False),
    (ApiError, None, 'exception', 'API error', False),
)


def _exception_answer(status_code: int | None, log_level: str, label: str,
                      both_keys: bool) -> Callable[[ApiError], Response]:
    """The handler for one row of ``_EXCEPTION_ANSWERS``: log, then ``{success: false, error}``."""
    def answer(ex: ApiError) -> Response:
        # The logger method is looked up per call, so a test that patches the module logger sees it.
        getattr(logger, log_level)(f"{label}: {ex.message}")
        body: dict[str, Any] = {'success': False, 'error': ex.message}
        if both_keys:
            body['message'] = ex.message
        return Response(
            status_code=ex.status_code if status_code is None else status_code,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps(body),
        )
    return answer


def _invocation_model_profile(event: object) -> str | None:
    """The model profile of an API invocation: verified Cognito groups first, then an internal event's field."""
    groups = get_caller_groups(event) if isinstance(event, dict) else []
    return profile_for_groups(groups) or profile_from_job_event(event)


def api_handler(func):
    """
    Combined decorator for Lambda API handlers.

    Applies in order:
    1. logger.inject_lambda_context - Adds request context to logs
    2. tracer.capture_lambda_handler - X-Ray tracing
    3. metrics.log_metrics - CloudWatch metrics with cold start
    4. measure_invocation_cost - one `invocation_cost` CPU line per request
       (innermost, so it is written inside the Powertools context)
    Outermost: with_test_run_tag - `test_run=<run id>` on every line of a request
    whose User-Agent carries the e2e suite's `voc-e2e/<run id>` token, removed
    again for every other request (shared/e2e_tag.py)

    Usage:
        @api_handler
        def lambda_handler(event, context):
            return app.resolve(event, context)

    Innermost of all: the model profile (shared/model_profile.py) — from the verified
    ``cognito:groups`` claim, or the stamped field of an internal (assist / job) event.
    """
    measured = measure_invocation_cost(with_model_profile(_invocation_model_profile)(func))
    return with_test_run_tag(logger)(logger.inject_lambda_context(
        tracer.capture_lambda_handler(
            metrics.log_metrics(capture_cold_start_metric=True)(measured))))


__all__ = [
    'ALL_TIME_DAYS',
    'DATE_BASIS_IMPORTED',
    'DATE_BASIS_REVIEW',
    'DEFAULT_CATEGORIES',
    'MAX_FEEDBACK_WINDOW_DAYS',
    'MAX_PERSONAS_PER_GENERATION',
    'api_handler',
    'create_api_resolver',
    'effective_window_days',
    'get_caller_groups',
    'get_caller_subject',
    'get_configured_categories',
    'requested_window_cutoff',
    'require_admin',
    'validate_bool',
    'validate_date_basis',
    'validate_days',
    'validate_int',
    'validate_limit',
]


# Default categories fallback (used when settings not configured)
DEFAULT_CATEGORIES = [
    'delivery', 'customer_support', 'product_quality', 'pricing',
    'website', 'app', 'billing', 'returns', 'communication', 'other'
]

# Cache for configured categories
_categories_cache: list | None = None
_categories_cache_time: float | None = None
CATEGORIES_CACHE_TTL = 300  # 5 minutes


def get_raw_categories_config(aggregates_table) -> list[dict]:
    """
    Fetch raw categories config objects from DynamoDB settings with caching.

    Returns list of category dicts (with name, description, subcategories).
    Returns empty list if not configured.
    """
    global _categories_cache, _categories_cache_time

    if not aggregates_table:
        return []

    now = datetime.now(UTC).timestamp()

    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache

    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        categories = item.get('categories') if item else None
        if categories:
            _categories_cache = categories
            _categories_cache_time = now
            logger.info(f"Loaded {len(categories)} categories from settings")
            return categories
    except Exception as e:
        logger.exception(f"Could not fetch categories from settings: {e}")

    _categories_cache = []
    _categories_cache_time = now
    return _categories_cache


def get_configured_categories(aggregates_table) -> list:
    """
    Fetch configured category names from DynamoDB settings with caching.

    Returns list of category name strings, falling back to DEFAULT_CATEGORIES.
    """
    raw = get_raw_categories_config(aggregates_table)
    if raw:
        return [cat.get('name') for cat in raw if cat.get('name')]
    return DEFAULT_CATEGORIES


def clear_categories_cache():
    """Clear the categories cache. Useful for testing or forced refresh."""
    global _categories_cache, _categories_cache_time
    _categories_cache = None
    _categories_cache_time = None
