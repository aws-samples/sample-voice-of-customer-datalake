"""
Shared API utilities for VoC Lambda functions.
Provides common helpers, encoders, validators, and decorators.
"""

import json
import os
import functools
from decimal import Decimal
from datetime import datetime, timezone

from aws_lambda_powertools.event_handler import APIGatewayRestResolver, CORSConfig, Response, content_types

from shared.logging import logger, tracer, metrics
from shared.exceptions import (
    ApiError,
    ValidationError,
    NotFoundError,
    ConfigurationError,
    ServiceError,
    AuthorizationError,
    ConflictError,
)

# Date-basis values live in shared.feedback (the data layer) so job Lambdas
# don't import API-resolver machinery for constants; re-exported here for
# API handlers and backward compatibility.
from shared.feedback import (  # noqa: F401 — re-export
    DATE_BASIS_IMPORTED, DATE_BASIS_REVIEW, VALID_DATE_BASES, validate_date_basis,
)


class DecimalEncoder(json.JSONEncoder):
    """JSON encoder that handles Decimal types from DynamoDB."""
    def default(self, obj):
        return decimal_default(obj)


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


def validate_days(
    value: str | int | None,
    default: int = 7,
    min_val: int = 1,
    max_val: int = 365
) -> int:
    """Validate and bound days parameter. Convenience wrapper around validate_int."""
    return validate_int(value, default=default, min_val=min_val, max_val=max_val)


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
      calling this (``validate_bool`` makes the mirror argument, and
      ``projects_handler``'s ``_is_clampable_number`` is such a check).
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
    except Exception:
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


def require_admin(event: dict) -> None:
    """Raise AuthorizationError (403) unless the caller is in the admins group.

    The Cognito authorizer only proves authentication; org-wide mutations
    (user administration, AI model selection) must also check the group.
    """
    if 'admins' not in get_caller_groups(event):
        raise AuthorizationError('Admin access required')


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
        expose_headers=["Content-Type"],
        max_age=300,
        allow_credentials=False,
    )


def create_api_resolver(allowed_origin: str | None = None) -> APIGatewayRestResolver:
    """
    Create pre-configured API Gateway resolver with standard CORS and exception handlers.
    
    Args:
        allowed_origin: Override origin, defaults to ALLOWED_ORIGIN env var
    
    Returns:
        Configured APIGatewayRestResolver instance with exception handlers registered
    """
    cors_config = create_cors_config(allowed_origin)
    app = APIGatewayRestResolver(cors=cors_config, enable_validation=True)
    
    # Register exception handlers for consistent error responses
    _register_exception_handlers(app)
    
    return app


def _register_exception_handlers(app: APIGatewayRestResolver) -> None:
    """
    Register exception handlers for all custom API exceptions.
    
    This ensures all API errors return a consistent format:
    {
        "success": false,
        "error": "Human-readable error message"
    }
    """
    
    @app.exception_handler(ValidationError)
    def handle_validation_error(ex: ValidationError):
        logger.warning(f"Validation error: {ex.message}")
        return Response(
            status_code=400,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(NotFoundError)
    def handle_not_found_error(ex: NotFoundError):
        logger.warning(f"Not found: {ex.message}")
        return Response(
            status_code=404,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(ConfigurationError)
    def handle_configuration_error(ex: ConfigurationError):
        logger.error(f"Configuration error: {ex.message}")
        return Response(
            status_code=500,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(ServiceError)
    def handle_service_error(ex: ServiceError):
        logger.exception(f"Service error: {ex.message}")
        return Response(
            status_code=500,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(AuthorizationError)
    def handle_authorization_error(ex: AuthorizationError):
        logger.warning(f"Authorization error: {ex.message}")
        return Response(
            status_code=403,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(ConflictError)
    def handle_conflict_error(ex: ConflictError):
        logger.warning(f"Conflict error: {ex.message}")
        return Response(
            status_code=409,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )
    
    @app.exception_handler(ApiError)
    def handle_api_error(ex: ApiError):
        """Catch-all for any ApiError subclass not explicitly handled."""
        logger.exception(f"API error: {ex.message}")
        return Response(
            status_code=ex.status_code,
            content_type=content_types.APPLICATION_JSON,
            body=json.dumps({'success': False, 'error': ex.message})
        )


def api_handler(func):
    """
    Combined decorator for Lambda API handlers.
    
    Applies in order:
    1. logger.inject_lambda_context - Adds request context to logs
    2. tracer.capture_lambda_handler - X-Ray tracing
    3. metrics.log_metrics - CloudWatch metrics with cold start
    
    Usage:
        @api_handler
        def lambda_handler(event, context):
            return app.resolve(event, context)
    """
    @logger.inject_lambda_context
    @tracer.capture_lambda_handler
    @metrics.log_metrics(capture_cold_start_metric=True)
    @functools.wraps(func)
    def wrapper(event, context):
        return func(event, context)
    return wrapper


# Re-export exceptions for convenience
__all__ = [
    'DecimalEncoder',
    'validate_days',
    'validate_limit', 
    'validate_int',
    'validate_bool',
    'validate_date_basis',
    'MAX_PERSONAS_PER_GENERATION',
    'DATE_BASIS_IMPORTED',
    'DATE_BASIS_REVIEW',
    'create_cors_config',
    'create_api_resolver',
    'api_handler',
    'get_caller_groups',
    'get_caller_subject',
    'require_admin',
    'get_configured_categories',
    'DEFAULT_CATEGORIES',
    # Exceptions
    'ApiError',
    'ValidationError',
    'NotFoundError',
    'ConfigurationError',
    'ServiceError',
    'AuthorizationError',
    'ConflictError',
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

    now = datetime.now(timezone.utc).timestamp()

    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache

    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        if item and item.get('categories'):
            _categories_cache = item.get('categories', [])
            _categories_cache_time = now
            logger.info(f"Loaded {len(_categories_cache)} categories from settings")
            return _categories_cache
    except Exception as e:
        logger.warning(f"Could not fetch categories from settings: {e}")

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
