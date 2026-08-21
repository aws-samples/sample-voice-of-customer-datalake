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
        # Both persona fields, because the processor writes both — and the metrics
        # axis buckets by the ARCHETYPE (`persona_type`), so a fixture carrying
        # only a name would agree with the aggregator about a field production
        # rarely produces. See test_persona_field_lockstep.py.
        'persona_name': 'Happy Customer',
        'persona_type': 'advocate',
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
        'persona_type': 'churn_risk',
    }


@pytest.fixture
def sample_anonymous_feedback_item():
    """The shape of nearly every item this platform really ingests.

    An archetype and NO name: the enrichment contract declares `persona.name` as
    "string or null", the corpus is scraped reviews and mostly anonymous form
    submissions, and the processor strips None before writing — so an anonymous item
    arrives with no `persona_name` key at all. Bucketing the persona axis by that
    field put 99.97% of a 6,239-item corpus in one `Unknown` bucket, which is why
    the axis buckets by `persona_type`. A fixture, because the two fixtures above
    both carry a name and so cannot tell the two fields apart.
    """
    return {
        'pk': 'SOURCE#webscraper',
        'sk': 'FEEDBACK#anon1',
        'feedback_id': 'anon1',
        'date': '2025-01-15',
        'source_platform': 'webscraper',
        'category': 'delivery',
        'sentiment_label': 'negative',
        'sentiment_score': Decimal('-0.4'),
        'urgency': 'low',
        'persona_type': 'churn_risk',
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
