"""Test fixtures for document generator job."""

import pytest

# Import shared fixtures
from jobs.conftest import *  # noqa: F401, F403


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
