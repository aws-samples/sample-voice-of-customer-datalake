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


class DecimalEncoder(json.JSONEncoder):
    """JSON encoder that handles Decimal types from DynamoDB."""
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def decimal_default(obj):
    """JSON serializer for Decimal types.
    
    Use with json.dumps: json.dumps(data, default=decimal_default)
    
    Args:
        obj: Object to serialize
        
    Returns:
        float if obj is Decimal
        
    Raises:
        TypeError: If obj is not a Decimal
    """
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def validate_days(
    value: str | int | None,
    default: int = 7,
    min_val: int = 1,
    max_val: int = 365
) -> int:
    """Validate and bound days parameter."""
    try:
        days = int(value) if value is not None else default
        return max(min_val, min(days, max_val))
    except (ValueError, TypeError):
        return default


def validate_limit(
    value: str | int | None,
    default: int = 50,
    min_val: int = 1,
    max_val: int = 100
) -> int:
    """Validate and bound limit parameter."""
    try:
        limit = int(value) if value is not None else default
        return max(min_val, min(limit, max_val))
    except (ValueError, TypeError):
        return default


def validate_int(
    value: str | int | None,
    default: int,
    min_val: int = 1,
    max_val: int = 100
) -> int:
    """Generic integer validation with bounds."""
    try:
        val = int(value) if value is not None else default
        return max(min_val, min(val, max_val))
    except (ValueError, TypeError):
        return default


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
    'create_cors_config',
    'create_api_resolver',
    'api_handler',
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


def get_configured_categories(aggregates_table) -> list:
    """
    Fetch configured categories from DynamoDB settings with caching.
    
    Args:
        aggregates_table: DynamoDB Table resource for aggregates
    
    Returns:
        List of category names
    """
    global _categories_cache, _categories_cache_time
    
    if not aggregates_table:
        logger.warning("Aggregates table not provided, using default categories")
        return DEFAULT_CATEGORIES
    
    now = datetime.now(timezone.utc).timestamp()
    
    # Return cached if still valid
    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache
    
    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        if item and item.get('categories'):
            _categories_cache = [cat.get('name') for cat in item.get('categories', []) if cat.get('name')]
            _categories_cache_time = now
            logger.info(f"Loaded {len(_categories_cache)} categories from settings")
            return _categories_cache
    except Exception as e:
        logger.warning(f"Could not fetch categories from settings: {e}")
    
    # Fallback to defaults
    _categories_cache = DEFAULT_CATEGORIES
    _categories_cache_time = now
    return _categories_cache


def clear_categories_cache():
    """Clear the categories cache. Useful for testing or forced refresh."""
    global _categories_cache, _categories_cache_time
    _categories_cache = None
    _categories_cache_time = None
