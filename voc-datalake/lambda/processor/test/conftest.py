"""Shared pytest fixtures for processor tests."""
import os
from unittest.mock import MagicMock

import pytest

# Set processor-specific environment variables
os.environ.setdefault('IDEMPOTENCY_TABLE', 'test-idempotency')
os.environ.setdefault('PRIMARY_LANGUAGE', 'en')
os.environ.setdefault('BEDROCK_MODEL_ID', 'test-model-id')


@pytest.fixture(autouse=True)
def _no_dimension_or_source_settings():
    """No dimensions and no source profiles unless a test seeds them.

    The processor reads both through its module-level aggregates table; seeding
    the cache keeps every test that does not care from sending that read anywhere.
    """
    from processor import handler

    # Stamped at +inf so `now - stamp` is never past the TTL: the seed never expires.
    seeded = (float('inf'), [])
    handler._settings_cache.clear()
    handler._settings_cache.update({'dimensions': seeded, 'sources': seeded})
    yield
    handler._settings_cache.clear()


@pytest.fixture
def lambda_context():
    """A mock Lambda context (the shape Powertools' inject_lambda_context reads)."""
    context = MagicMock()
    context.function_name = 'test-processor'
    context.memory_limit_in_mb = 1024
    context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789:function:test-processor'
    context.aws_request_id = 'test-request-id-12345'
    return context


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
