"""
Shared AWS client utilities for VoC Lambda functions.
Provides pre-configured clients with connection reuse.
"""

import json
import boto3
from functools import lru_cache
from shared.logging import logger

# Module-level clients for connection reuse across invocations
_dynamodb_resource = None
_s3_client = None
_sqs_client = None
_secrets_client = None
_bedrock_client = None


def get_dynamodb_resource():
    """Get shared DynamoDB resource with connection reuse."""
    global _dynamodb_resource
    if _dynamodb_resource is None:
        _dynamodb_resource = boto3.resource("dynamodb")
    return _dynamodb_resource


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
    """Get shared Bedrock Runtime client with connection reuse."""
    global _bedrock_client
    if _bedrock_client is None:
        _bedrock_client = boto3.client("bedrock-runtime")
    return _bedrock_client


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


# Bedrock model ID - Claude Sonnet 4.5 global inference profile
BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"


def invoke_bedrock(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.1,
) -> str:
    """
    Invoke Bedrock Claude model with standard configuration.

    Args:
        prompt: User message/prompt
        system_prompt: Optional system prompt
        max_tokens: Maximum tokens in response (default: 2048)
        temperature: Model temperature (default: 0.1)

    Returns:
        Model response text

    Raises:
        Exception: On Bedrock API errors
    """
    client = get_bedrock_client()

    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [{"role": "user", "content": prompt}],
    }

    if system_prompt:
        request_body["system"] = system_prompt

    response = client.invoke_model(
        modelId=BEDROCK_MODEL_ID,
        body=json.dumps(request_body),
        contentType="application/json",
        accept="application/json",
    )

    response_body = json.loads(response["body"].read())
    return response_body["content"][0]["text"]
