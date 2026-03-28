"""Shared pytest fixtures for processor tests."""
import json
import os
import pytest
from unittest.mock import MagicMock

# Set processor-specific environment variables
os.environ.setdefault('IDEMPOTENCY_TABLE', 'test-idempotency')
os.environ.setdefault('PRIMARY_LANGUAGE', 'en')
os.environ.setdefault('BEDROCK_MODEL_ID', 'test-model-id')


@pytest.fixture
def mock_dynamodb_table():
    """Create a mock DynamoDB table."""
    table = MagicMock()
    table.query.return_value = {'Items': [], 'Count': 0}
    table.get_item.return_value = {}
    table.put_item.return_value = {}
    table.update_item.return_value = {}
    return table


@pytest.fixture
def mock_comprehend_client():
    """Mock Comprehend client for language detection and sentiment."""
    client = MagicMock()
    client.detect_dominant_language.return_value = {
        'Languages': [{'LanguageCode': 'en', 'Score': 0.99}]
    }
    client.detect_sentiment.return_value = {
        'Sentiment': 'POSITIVE',
        'SentimentScore': {
            'Positive': 0.8,
            'Negative': 0.1,
            'Neutral': 0.05,
            'Mixed': 0.05
        }
    }
    return client


@pytest.fixture
def mock_translate_client():
    """Mock Translate client."""
    client = MagicMock()
    client.translate_text.return_value = {
        'TranslatedText': 'Translated text'
    }
    return client


@pytest.fixture
def mock_bedrock_response():
    """Create a mock Bedrock response."""
    def _create_response(insights: dict):
        return json.dumps({
            'content': [{'text': json.dumps(insights)}]
        }).encode()
    return _create_response


@pytest.fixture
def sample_sqs_record():
    """Create a sample SQS record body."""
    return {
        'id': 'test-source-id-123',
        'source_platform': 'webscraper',
        'source_channel': 'reviews',
        'text': 'This product is amazing! Great quality and fast shipping.',
        'rating': 5,
        'url': 'https://example.com/review/123',
        'created_at': '2025-01-15T10:30:00Z',
        'ingested_at': '2025-01-15T11:00:00Z',
        'brand_name': 'TestBrand',
    }


@pytest.fixture
def sample_llm_insights():
    """Sample LLM insights response."""
    return {
        'category': 'product_quality',
        'subcategory': 'durability',
        'journey_stage': 'usage',
        'sentiment_label': 'positive',
        'sentiment_score': 0.85,
        'urgency': 'low',
        'impact_area': 'product',
        'problem_summary': None,
        'problem_root_cause_hypothesis': None,
        'direct_customer_quote': 'This product is amazing!',
        'persona': {
            'name': 'Satisfied Customer',
            'type': 'existing_customer',
            'attributes': {
                'inferred_segment': 'loyal_customer',
                'confidence': 'high'
            }
        }
    }


@pytest.fixture
def lambda_context():
    """Create a mock Lambda context."""
    context = MagicMock()
    context.function_name = 'test-processor'
    context.memory_limit_in_mb = 512
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test-processor'
    context.aws_request_id = 'test-request-id-12345'
    return context
