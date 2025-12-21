"""
Shared idempotency utilities for VoC Lambda functions.
Uses AWS Lambda Powertools Idempotency to prevent duplicate processing.

Idempotency ensures that processing the same event multiple times produces
the same result and side effects only happen once - critical for:
- SQS message retries
- Lambda retries on failure
- Concurrent executions of the same event
"""

import os
from aws_lambda_powertools.utilities.idempotency import (
    DynamoDBPersistenceLayer,
    IdempotencyConfig,
    idempotent,
    idempotent_function,
)
from aws_lambda_powertools.utilities.idempotency.exceptions import (
    IdempotencyAlreadyInProgressError,
    IdempotencyItemAlreadyExistsError,
)

# Re-export for convenience
__all__ = [
    "get_idempotency_config",
    "get_persistence_layer",
    "idempotent",
    "idempotent_function",
    "IdempotencyAlreadyInProgressError",
    "IdempotencyItemAlreadyExistsError",
]

# Module-level cache for persistence layer
_persistence_layer = None


def get_persistence_layer(table_name: str = None) -> DynamoDBPersistenceLayer:
    """
    Get or create DynamoDB persistence layer for idempotency.
    
    Args:
        table_name: DynamoDB table name. Defaults to IDEMPOTENCY_TABLE env var.
        
    Returns:
        DynamoDBPersistenceLayer instance (cached for connection reuse)
    """
    global _persistence_layer
    
    if _persistence_layer is None:
        table = table_name or os.environ.get("IDEMPOTENCY_TABLE", "")
        if not table:
            raise ValueError(
                "Idempotency table not configured. "
                "Set IDEMPOTENCY_TABLE environment variable."
            )
        _persistence_layer = DynamoDBPersistenceLayer(table_name=table)
    
    return _persistence_layer


def get_idempotency_config(
    expires_after_seconds: int = 3600,
    event_key_jmespath: str = None,
    use_local_cache: bool = True,
    local_cache_max_items: int = 256,
    raise_on_no_idempotency_key: bool = False,
) -> IdempotencyConfig:
    """
    Create idempotency configuration with sensible defaults.
    
    Args:
        expires_after_seconds: How long to remember processed events (default: 1 hour)
        event_key_jmespath: JMESPath to extract idempotency key from event
        use_local_cache: Use in-memory cache to reduce DynamoDB reads (default: True)
        local_cache_max_items: Max items in local cache (default: 256)
        raise_on_no_idempotency_key: Raise error if key extraction fails (default: False)
        
    Returns:
        IdempotencyConfig instance
        
    Example JMESPath expressions:
        - SQS batch: "Records[*].messageId" 
        - Single record: "body.id"
        - API Gateway: "requestContext.requestId"
        - Custom: "powertools_json(body).source_platform"
    """
    return IdempotencyConfig(
        expires_after_seconds=expires_after_seconds,
        event_key_jmespath=event_key_jmespath,
        use_local_cache=use_local_cache,
        local_cache_max_items=local_cache_max_items,
        raise_on_no_idempotency_key=raise_on_no_idempotency_key,
    )
