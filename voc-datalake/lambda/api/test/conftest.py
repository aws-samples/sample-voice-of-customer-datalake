"""
Shared pytest fixtures for Lambda API handler tests.
"""
import os
import sys
import json
import pytest
from unittest.mock import MagicMock
from datetime import datetime, timezone

# Add lambda directory to path for shared module imports
# and lambda/api directory for handler imports
lambda_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
api_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# This directory too, so helper modules beside the tests (plugin_manifests.py)
# import from conftest as well as from the test files. pytest adds it when it
# imports a TEST module, but conftest.py is imported before that happens.
test_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, lambda_dir)
sys.path.insert(0, api_dir)
sys.path.insert(0, test_dir)

# Set environment variables BEFORE importing handlers
os.environ['FEEDBACK_TABLE'] = 'test-feedback'
os.environ['AGGREGATES_TABLE'] = 'test-aggregates'
os.environ['CONVERSATIONS_TABLE'] = 'test-conversations'
os.environ['PROJECTS_TABLE'] = 'test-projects'
os.environ['JOBS_TABLE'] = 'test-jobs'
os.environ['AWS_DEFAULT_REGION'] = 'us-east-1'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-voc-api'
os.environ['POWERTOOLS_METRICS_NAMESPACE'] = 'TestVoC'
os.environ['ALLOWED_ORIGIN'] = 'http://localhost:5173'
os.environ['SECRETS_ARN'] = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secrets'
os.environ['RAW_DATA_BUCKET'] = 'test-raw-data-bucket'
os.environ['PROCESSING_QUEUE_URL'] = 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue'
os.environ['USER_POOL_ID'] = 'us-east-1_testpool'


# Imported after the sys.path setup above, which is what makes it resolvable.
from plugin_manifests import PLUGIN_SECRET_DEFAULTS


@pytest.fixture
def plugin_secret_defaults(monkeypatch):
    """Give the integrations handler the PLUGIN_SECRET_DEFAULTS that CDK sets.

    Any test exercising GET /integrations/status needs this: without it the
    handler knows of no sources and returns {}. The lru_cache is cleared on both
    sides so neither this value nor a previous one leaks between tests.
    """
    import integrations_handler as h

    monkeypatch.setenv(h.PLUGIN_SECRET_DEFAULTS_VAR, json.dumps(PLUGIN_SECRET_DEFAULTS))
    h._plugin_secret_defaults.cache_clear()
    yield PLUGIN_SECRET_DEFAULTS
    h._plugin_secret_defaults.cache_clear()


@pytest.fixture
def feedback_form_handler():
    """The imported `feedback_form_handler` module.

    `sys.path` already carries `lambda/api` (set at the top of this file), so the
    import needs no per-test path juggling. A fixture rather than a module-level
    import so that a test importing it is still what triggers the import, and a
    handler that cannot be imported fails the tests that use it rather than
    collection of the whole file.
    """
    import feedback_form_handler
    return feedback_form_handler


@pytest.fixture
def mock_dynamodb_table():
    """Create a mock DynamoDB table with common methods."""
    table = MagicMock()
    table.query.return_value = {'Items': [], 'Count': 0}
    table.get_item.return_value = {}
    table.put_item.return_value = {}
    table.delete_item.return_value = {}
    table.update_item.return_value = {}
    return table


@pytest.fixture
def mock_dynamodb_resource(mock_dynamodb_table):
    """Mock boto3 DynamoDB resource."""
    resource = MagicMock()
    resource.Table.return_value = mock_dynamodb_table
    return resource


@pytest.fixture
def mock_bedrock_client():
    """Mock Bedrock runtime client for AI features."""
    client = MagicMock()
    client.invoke_model.return_value = {
        'body': MagicMock(read=lambda: json.dumps({
            'content': [{'text': 'Test AI response from Claude Sonnet 4.5'}]
        }).encode())
    }
    return client


@pytest.fixture
def mock_bedrock_response():
    """Factory fixture to create custom Bedrock responses."""
    def _create_response(text: str):
        return {
            'body': MagicMock(read=lambda: json.dumps({
                'content': [{'text': text}]
            }).encode())
        }
    return _create_response


@pytest.fixture
def api_gateway_event():
    """Factory fixture to create API Gateway events."""
    def _create_event(
        method: str = 'GET',
        path: str = '/feedback',
        query_params: dict = None,
        body: dict = None,
        path_params: dict = None,
        headers: dict = None,
        resource: str = None
    ):
        # Auto-generate resource from path if not provided
        # For proxy routes, replace the proxy value with {proxy+}
        if resource is None:
            resource = path
            if path_params and 'proxy' in path_params:
                proxy_value = path_params['proxy']
                resource = path.replace(f'/{proxy_value}', '/{proxy+}')
        
        return {
            'httpMethod': method,
            'path': path,
            'resource': resource,
            'queryStringParameters': query_params or {},
            'pathParameters': path_params or {},
            'body': json.dumps(body) if body else None,
            'headers': {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer test-token',
                **(headers or {})
            },
            'requestContext': {
                'authorizer': {
                    'claims': {
                        'sub': 'test-user-id',
                        'email': 'test@example.com',
                        'cognito:groups': 'admins'
                    }
                },
                'requestId': 'test-request-id',
                'stage': 'test'
            },
            'isBase64Encoded': False
        }
    return _create_event


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-voc-api'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:test-voc-api'
    context.aws_request_id = 'test-request-id-12345'
    context.get_remaining_time_in_millis.return_value = 30000
    return context


@pytest.fixture
def sample_feedback_item():
    """Create a sample feedback item for testing."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#test-123',
        'feedback_id': 'test-123',
        'source_platform': 'webscraper',
        'source_id': 'review-456',
        'original_text': 'Great product, love the features!',
        'sentiment_label': 'positive',
        'sentiment_score': 0.85,
        'category': 'product_quality',
        'urgency': 'low',
        'date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
        'source_created_at': datetime.now(timezone.utc).isoformat(),
        'processed_at': datetime.now(timezone.utc).isoformat(),
    }


@pytest.fixture
def sample_feedback_items(sample_feedback_item):
    """Create multiple sample feedback items."""
    items = [sample_feedback_item]
    items.append({
        **sample_feedback_item,
        'pk': 'SOURCE#manual_import',
        'sk': 'FEEDBACK#test-456',
        'feedback_id': 'test-456',
        'source_platform': 'manual_import',
        'original_text': 'Delivery was slow, disappointed.',
        'sentiment_label': 'negative',
        'sentiment_score': -0.65,
        'category': 'delivery',
        'urgency': 'high',
    })
    return items
