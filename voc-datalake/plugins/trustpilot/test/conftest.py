"""Shared fixtures for Trustpilot plugin tests.

Note: Path setup and environment variables are configured in plugins/conftest.py
which is loaded first by pytest.
"""
import os
import json
import pytest
from unittest.mock import MagicMock

# Override SOURCE_PLATFORM for Trustpilot tests
os.environ['SOURCE_PLATFORM'] = 'trustpilot'


@pytest.fixture
def mock_trustpilot_secrets():
    """Mock Trustpilot API credentials."""
    return {
        'trustpilot_api_key': 'tp-api-key-123',
        'trustpilot_api_secret': 'tp-api-secret-456',
        'trustpilot_business_unit_id': 'tp-buid-789',
        'trustpilot_webhook_secret': 'tp-webhook-secret',
    }


@pytest.fixture
def mock_trustpilot_review():
    """Sample Trustpilot review from API."""
    from datetime import datetime, timezone
    # Use a recent date to ensure it's after the watermark
    recent_date = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    return {
        'id': 'review-abc123',
        'createdAt': recent_date,
        'stars': 5,
        'title': 'Excellent Service',
        'text': 'Really happy with the product and customer service!',
        'consumer': {
            'displayName': 'John D.',
            'id': 'consumer-123',
        },
        'links': [
            {'href': 'https://www.trustpilot.com/reviews/review-abc123', 'rel': 'self'}
        ],
    }


@pytest.fixture
def mock_trustpilot_api_response(mock_trustpilot_review):
    """Mock Trustpilot API reviews response."""
    return {
        'reviews': [mock_trustpilot_review],
        'links': [
            {'href': 'https://api.trustpilot.com/v1/business-units/123/reviews?page=2', 'rel': 'next'}
        ],
    }


@pytest.fixture
def mock_trustpilot_webhook_payload():
    """Sample Trustpilot webhook payload."""
    return {
        'eventType': 'service-review-created',
        'review': {
            'id': 'webhook-review-456',
            'createdAt': '2025-01-16T14:00:00Z',
            'stars': 4,
            'title': 'Good Experience',
            'text': 'Product works as expected.',
            'consumer': {'displayName': 'Jane S.'},
            'links': [{'href': 'https://trustpilot.com/review/456'}],
        },
    }


@pytest.fixture
def lambda_context():
    """Mock Lambda context."""
    context = MagicMock()
    context.function_name = 'trustpilot-ingestor'
    context.aws_request_id = 'test-request-id'
    return context
