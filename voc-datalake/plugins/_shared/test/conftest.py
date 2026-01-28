"""Shared pytest fixtures for plugin tests.

Note: Path setup and environment variables are configured in plugins/conftest.py
which is loaded first by pytest.
"""
import os
import json
import pytest
from unittest.mock import MagicMock
from datetime import datetime, timezone


@pytest.fixture
def mock_dynamodb_table():
    """Create a mock DynamoDB table."""
    table = MagicMock()
    table.query.return_value = {'Items': [], 'Count': 0}
    table.get_item.return_value = {}
    table.put_item.return_value = {}
    table.delete_item.return_value = {}
    return table


@pytest.fixture
def mock_dynamodb_resource(mock_dynamodb_table):
    """Mock boto3 DynamoDB resource."""
    resource = MagicMock()
    resource.Table.return_value = mock_dynamodb_table
    return resource


@pytest.fixture
def mock_s3_client():
    """Mock S3 client."""
    client = MagicMock()
    client.put_object.return_value = {}
    return client


@pytest.fixture
def mock_sqs_client():
    """Mock SQS client."""
    client = MagicMock()
    client.send_message_batch.return_value = {'Successful': [], 'Failed': []}
    return client


@pytest.fixture
def mock_secrets():
    """Mock secrets from Secrets Manager."""
    return {
        'test_source_api_key': 'test-api-key-123',
        'test_source_api_secret': 'test-api-secret-456',
        'webscraper_configs': '[]',
    }


@pytest.fixture
def api_gateway_event():
    """Create a sample API Gateway event."""
    def _create_event(
        method: str = 'POST',
        path: str = '/webhooks/test',
        body: dict = None,
        headers: dict = None,
        is_base64: bool = False
    ):
        body_str = json.dumps(body) if body else '{}'
        return {
            'httpMethod': method,
            'path': path,
            'body': body_str,
            'headers': headers or {'Content-Type': 'application/json'},
            'isBase64Encoded': is_base64,
            'requestContext': {
                'identity': {'sourceIp': '192.168.1.1'}
            }
        }
    return _create_event


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-function'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test'
    context.aws_request_id = 'test-request-id'
    return context


@pytest.fixture
def sample_feedback_item():
    """Create a sample feedback item."""
    return {
        'id': 'test-123',
        'text': 'Great product! Really love it.',
        'rating': 5,
        'created_at': '2025-01-01T12:00:00Z',
        'url': 'https://example.com/review/123',
        'channel': 'review',
        'author': 'Test User',
    }


@pytest.fixture
def sample_webhook_payload():
    """Create a sample webhook payload."""
    return {
        'eventType': 'review-created',
        'review': {
            'id': 'webhook-review-123',
            'text': 'Webhook review text',
            'stars': 4,
            'createdAt': '2025-01-02T10:00:00Z',
            'consumer': {'displayName': 'Webhook User'},
            'title': 'Good service',
            'links': [{'href': 'https://example.com/review/123'}]
        }
    }
