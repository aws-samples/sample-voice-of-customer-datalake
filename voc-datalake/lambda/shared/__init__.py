"""
Shared utilities for VoC Lambda functions.
"""

from shared.logging import logger, tracer, metrics, get_logger, get_tracer, get_metrics
from shared.http import fetch_with_retry, fetch_json_with_retry, create_retry_decorator, RETRYABLE_EXCEPTIONS
from shared.aws import (
    get_dynamodb_resource,
    get_s3_client,
    get_sqs_client,
    get_secrets_client,
    get_bedrock_client,
    get_secret,
    clear_secret_cache,
    invoke_bedrock,
    BEDROCK_MODEL_ID,
)

__all__ = [
    # Logging
    "logger",
    "tracer",
    "metrics",
    "get_logger",
    "get_tracer",
    "get_metrics",
    # HTTP
    "fetch_with_retry",
    "fetch_json_with_retry",
    "create_retry_decorator",
    "RETRYABLE_EXCEPTIONS",
    # AWS
    "get_dynamodb_resource",
    "get_s3_client",
    "get_sqs_client",
    "get_secrets_client",
    "get_bedrock_client",
    "get_secret",
    "clear_secret_cache",
    "invoke_bedrock",
    "BEDROCK_MODEL_ID",
]
