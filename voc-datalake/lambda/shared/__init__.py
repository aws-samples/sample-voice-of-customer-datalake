"""
Shared utilities for VoC Lambda functions.
"""

from shared.logging import logger, tracer, metrics
from shared.aws import (
    get_dynamodb_resource,
    get_s3_client,
    get_sqs_client,
    get_secrets_client,
    get_bedrock_client,
    get_lambda_client,
    get_secret,
    clear_secret_cache,
    invoke_lambda_async,
    BEDROCK_MODEL_ID,
)
from shared.converse import (
    converse,
    converse_chain,
)
from shared.idempotency import (
    get_idempotency_config,
    get_persistence_layer,
    idempotent,
    idempotent_function,
    IdempotencyAlreadyInProgressError,
    IdempotencyItemAlreadyExistsError,
)
from shared.tables import (
    get_jobs_table,
    get_aggregates_table,
    get_feedback_table,
    get_projects_table,
    clear_table_cache,
)
from shared.jobs import (
    create_job,
    update_job_status,
    job_handler,
    JobContext,
)
from shared.api import decimal_default
from shared.exceptions import (
    ApiError,
    ValidationError,
    NotFoundError,
    ConfigurationError,
    ServiceError,
    AuthorizationError,
    ConflictError,
)

__all__ = [
    # Logging
    "logger",
    "tracer",
    "metrics",
    # AWS
    "get_dynamodb_resource",
    "get_s3_client",
    "get_sqs_client",
    "get_secrets_client",
    "get_bedrock_client",
    "get_lambda_client",
    "get_secret",
    "clear_secret_cache",
    "invoke_lambda_async",
    "BEDROCK_MODEL_ID",
    # Converse API
    "converse",
    "converse_chain",
    # Idempotency
    "get_idempotency_config",
    "get_persistence_layer",
    "idempotent",
    "idempotent_function",
    "IdempotencyAlreadyInProgressError",
    "IdempotencyItemAlreadyExistsError",
    # Tables
    "get_jobs_table",
    "get_aggregates_table",
    "get_feedback_table",
    "get_projects_table",
    # Jobs
    "create_job",
    "update_job_status",
    "job_handler",
    "JobContext",
    # API utilities
    "decimal_default",
    # Exceptions
    "ApiError",
    "ValidationError",
    "NotFoundError",
    "ConfigurationError",
    "ServiceError",
    "AuthorizationError",
    "ConflictError",
]
