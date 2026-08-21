"""
Shared AWS client utilities for VoC Lambda functions.
Provides pre-configured clients with connection reuse.
"""

import json
import boto3
from functools import lru_cache
from shared.exceptions import ValidationError
from shared.logging import logger

# Module-level clients for connection reuse across invocations
_dynamodb_resource = None
_s3_client = None
_sqs_client = None
_secrets_client = None
_bedrock_client = None
_lambda_client = None


def get_dynamodb_resource():
    """Get shared DynamoDB resource with connection reuse."""
    global _dynamodb_resource
    if _dynamodb_resource is None:
        _dynamodb_resource = boto3.resource("dynamodb")
    return _dynamodb_resource


def is_conditional_check_failure(error: Exception) -> bool:
    """True for DynamoDB's ConditionalCheckFailedException, however it arrives.

    The error CODE in the response is the dependable signal — boto3's resource
    layer raises a dynamically-built ClientError subclass, so its type name is a
    botocore implementation detail. The type name is checked as well because a
    test double raises the named exception with no response payload.

    ONE copy, here, because every conditional write in this app needs the same
    predicate and each caller reaches it through a different failure path: a
    refused write is the EXPECTED outcome of a guarded update (a decrement with
    nothing to decrement, a status write against a record already terminal), so
    misclassifying it swallows a real error or raises on a benign one. A second
    copy is how the next arrival path for this exception gets fixed in one place
    and missed in the other. `product_doc_extractor/handler.py` cannot import
    this — it is stdlib+boto3 only by design, see its module docstring — and
    keeps its own copy with a comment pointing here.
    """
    response = getattr(error, 'response', None)
    code = (response.get('Error') or {}).get('Code') if isinstance(response, dict) else None
    return (code == 'ConditionalCheckFailedException'
            or type(error).__name__ == 'ConditionalCheckFailedException')


def get_s3_client():
    """Get shared S3 client with connection reuse.

    Configured with Signature Version 4 for KMS-encrypted bucket compatibility.
    """
    global _s3_client
    if _s3_client is None:
        from botocore.config import Config
        _s3_client = boto3.client(
            "s3",
            config=Config(signature_version="s3v4")
        )
    return _s3_client


def get_sqs_client():
    """Get shared SQS client with connection reuse."""
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = boto3.client("sqs")
    return _sqs_client


def get_secrets_client():
    """Get shared Secrets Manager client with connection reuse."""
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager")
    return _secrets_client


def get_bedrock_client():
    """Get shared Bedrock Runtime client with connection reuse.
    
    Uses extended read timeout (5 minutes) to handle long LLM responses
    that can take 2-3 minutes for complex persona generation tasks.
    """
    global _bedrock_client
    if _bedrock_client is None:
        from botocore.config import Config
        config = Config(
            read_timeout=300,  # 5 minutes for long LLM responses
            connect_timeout=10,
            retries={'max_attempts': 3}
        )
        _bedrock_client = boto3.client("bedrock-runtime", config=config)
    return _bedrock_client


def get_lambda_client():
    """Get shared Lambda client with connection reuse."""
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client("lambda")
    return _lambda_client


def invoke_lambda_async(function_name: str, payload: dict) -> dict:
    """
    Invoke a Lambda function asynchronously (fire-and-forget).
    
    Args:
        function_name: Lambda function name or ARN
        payload: Event payload dict
    
    Returns:
        Lambda invoke response (status only, no payload for async)
    """
    client = get_lambda_client()
    return client.invoke(
        FunctionName=function_name,
        InvocationType='Event',
        Payload=json.dumps(payload)
    )



@lru_cache(maxsize=10)
def get_secret(secret_arn: str) -> dict:
    """
    Get and cache secret value from Secrets Manager.

    Args:
        secret_arn: ARN or name of the secret

    Returns:
        Parsed secret as dict

    Note:
        Results are cached for the Lambda execution context.
        Cache is cleared on cold start.
    """
    try:
        client = get_secrets_client()
        response = client.get_secret_value(SecretId=secret_arn)
        return json.loads(response["SecretString"])
    except Exception as e:
        logger.error(f"Failed to load secret {secret_arn}: {e}")
        return {}


def clear_secret_cache():
    """Clear the secret cache. Useful for testing or forced refresh."""
    get_secret.cache_clear()


# Secrets Manager rejects a SecretString over 65,536 bytes.
SECRET_STRING_MAX_BYTES = 65536


def put_secret_json(client, secret_arn: str, secrets: dict) -> None:
    """Serialize *secrets* and write it via *client*, refusing an over-limit payload.

    Every writer of the shared API-credentials secret does read-modify-write on
    ONE JSON blob, so the bound that actually matters is the SERIALIZED TOTAL,
    not any single value. Capping values individually gets it wrong in both
    directions: N values under the per-value cap still add up past the service
    limit, and a legitimately large single value (the webscraper ``configs``
    array grows with every scraper a user adds) is refused though it fits.

    Checking here rather than at each call site is deliberate — this is the one
    choke point all five writers pass through, so the guard cannot be missed by
    a new one, and the caller that grows the blob is not always the caller that
    would have hit the limit.

    *client* is passed in rather than resolved through get_secrets_client(). Each
    handler already holds a module-level client, and that attribute is the seam
    every existing test patches; resolving a second one here would write for real
    under a test that believes it mocked the write.

    Raises:
        ValidationError: If the serialized secret exceeds the service limit.
            A 400 naming the size beats the opaque 500 that ``put_secret_value``
            raising ``InvalidParameterException`` produces, and it is raised
            BEFORE the write so the stored secret is left untouched.
    """
    payload = json.dumps(secrets)
    size = len(payload.encode())
    if size > SECRET_STRING_MAX_BYTES:
        raise ValidationError(
            f'Configuration is too large to store: {size} bytes exceeds the '
            f'{SECRET_STRING_MAX_BYTES}-byte limit. Remove some entries and retry.'
        )

    client.put_secret_value(SecretId=secret_arn, SecretString=payload)


# Default Bedrock model — Claude Sonnet 5 global cross-region inference profile.
# This is the ultimate fallback for text inference. The per-surface AI-model
# picker (shared/model_config.py) resolves a model per surface and only falls
# back to this constant when nothing is configured and the surface has no more
# specific default. Bumped from Sonnet 4.5 → Sonnet 5 (latest).
BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-5"
