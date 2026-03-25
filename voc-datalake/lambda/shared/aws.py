"""
Shared AWS client utilities for VoC Lambda functions.
Provides pre-configured clients with connection reuse.
"""

import json
import os
import boto3
from functools import lru_cache
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


# Bedrock model ID - Claude Sonnet 4.6 global cross-region inference profile
BEDROCK_MODEL_ID = "global.anthropic.claude-sonnet-4-6"
