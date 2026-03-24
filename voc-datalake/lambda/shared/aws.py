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


def invoke_self_async(payload: dict) -> dict:
    """
    Invoke the current Lambda function asynchronously.
    
    Uses AWS_LAMBDA_FUNCTION_NAME environment variable.
    
    Args:
        payload: Event payload dict
    
    Returns:
        Lambda invoke response
    
    Raises:
        ValueError: If AWS_LAMBDA_FUNCTION_NAME is not set
    """
    function_name = os.environ.get('AWS_LAMBDA_FUNCTION_NAME', '')
    if not function_name:
        raise ValueError("AWS_LAMBDA_FUNCTION_NAME environment variable not set")
    return invoke_lambda_async(function_name, payload)


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


def invoke_bedrock(
    prompt: str,
    system_prompt: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.1,
) -> str:
    """
    Invoke Bedrock Claude model using Converse API.

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

    messages = [{'role': 'user', 'content': [{'text': prompt}]}]
    
    kwargs = {
        'modelId': BEDROCK_MODEL_ID,
        'messages': messages,
        'inferenceConfig': {
            'maxTokens': max_tokens,
            'temperature': temperature,
        }
    }
    
    if system_prompt:
        kwargs['system'] = [{'text': system_prompt}]

    response = client.converse(**kwargs)
    
    content = response.get('output', {}).get('message', {}).get('content', [])
    return ''.join(block.get('text', '') for block in content if 'text' in block)
