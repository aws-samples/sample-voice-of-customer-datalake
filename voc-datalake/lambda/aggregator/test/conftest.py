"""Shared pytest fixtures for aggregator tests."""
import pytest
from unittest.mock import MagicMock
from decimal import Decimal


@pytest.fixture
def mock_aggregates_table():
    """Create a mock DynamoDB aggregates table."""
    table = MagicMock()
    table.update_item.return_value = {}
    table.get_item.return_value = {}
    return table


@pytest.fixture
def sample_feedback_item():
    """Sample feedback item from DynamoDB stream."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#abc123',
        'feedback_id': 'abc123',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'product_quality',
        'sentiment_label': 'positive',
        'sentiment_score': Decimal('0.85'),
        'urgency': 'low',
        'persona_name': 'Happy Customer',
    }


@pytest.fixture
def sample_urgent_feedback_item():
    """Sample urgent feedback item."""
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#urgent123',
        'feedback_id': 'urgent123',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'customer_support',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.75'),
        'urgency': 'high',
        'persona_name': 'Frustrated Customer',
    }


@pytest.fixture
def sample_dynamodb_stream_record(sample_feedback_item):
    """Create a sample DynamoDB stream record."""
    # Convert to DynamoDB format
    def to_dynamodb_format(item):
        result = {}
        for key, value in item.items():
            if isinstance(value, str):
                result[key] = {'S': value}
            elif isinstance(value, Decimal):
                result[key] = {'N': str(value)}
            elif isinstance(value, dict):
                result[key] = {'M': value}
            elif isinstance(value, list):
                result[key] = {'L': value}
            elif isinstance(value, bool):
                result[key] = {'BOOL': value}
        return result
    
    return {
        'eventName': 'INSERT',
        'dynamodb': {
            'NewImage': to_dynamodb_format(sample_feedback_item)
        }
    }


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-aggregator'
    context.memory_limit_in_mb = 256
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test-aggregator'
    context.aws_request_id = 'test-request-id-67890'
    return context
