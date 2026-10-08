"""Test fixtures for document generator job."""

from unittest.mock import patch

import pytest

# Import shared fixtures
from jobs.conftest import *  # noqa: F403

# The 200 K-token window every allowlisted model has (shared/model_config.py).
TEST_CONTEXT_WINDOW_TOKENS = 200_000


@pytest.fixture(autouse=True)
def fixed_context_window():
    """Pin the feedback budget's model window so no test resolves the live model.

    `_feedback_context` sizes the fetch from the 'documents' surface's model,
    which otherwise reads the settings item from DynamoDB with real credentials.
    """
    with patch('jobs.document_generator.handler.surface_context_window_tokens',
               return_value=TEST_CONTEXT_WINDOW_TOKENS):
        yield


@pytest.fixture
def prd_generation_event(sample_job_event):
    """Sample PRD generation job event."""
    return {
        **sample_job_event,
        'doc_config': {
            'doc_type': 'prd',
            'title': 'Test PRD',
            'feature_idea': 'Improve user onboarding flow',
            'data_sources': {
                'feedback': True,
                'personas': True,
                'documents': False,
            },
            'days': 30,
        }
    }


@pytest.fixture
def prfaq_generation_event(sample_job_event):
    """Sample PR-FAQ generation job event."""
    return {
        **sample_job_event,
        'doc_config': {
            'doc_type': 'prfaq',
            'title': 'Test PR-FAQ',
            'feature_idea': 'New mobile app feature',
            'data_sources': {
                'feedback': True,
                'personas': True,
            },
            'customer_questions': [
                'Small business owners',
                'They struggle with inventory management',
                'Save 10 hours per week',
                'Customer interviews and feedback',
                'Simple mobile-first experience',
            ],
            'days': 30,
        }
    }
