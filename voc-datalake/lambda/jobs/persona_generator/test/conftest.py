"""Test fixtures for persona generator job."""

import pytest
from unittest.mock import patch, MagicMock

# Import shared fixtures
from jobs.conftest import *  # noqa: F401, F403


@pytest.fixture
def mock_generate_personas():
    """Mock the generate_personas function where it's used in the handler."""
    mock = MagicMock(return_value={
        'success': True,
        'personas': [
            {'persona_id': 'persona_1', 'name': 'Test Persona 1'},
            {'persona_id': 'persona_2', 'name': 'Test Persona 2'},
        ],
        'metadata': {'feedback_count': 50}
    })
    with patch('api.projects.generate_personas', mock), \
         patch('jobs.persona_generator.handler.generate_personas', mock, create=True):
        yield mock


@pytest.fixture
def persona_generation_event(sample_job_event):
    """Sample persona generation job event."""
    return {
        **sample_job_event,
        'filters': {
            'sources': ['app_store', 'play_store'],
            'categories': ['usability'],
            'sentiments': ['negative', 'neutral'],
            'days': 30,
            'persona_count': 3,
            'custom_instructions': '',
        }
    }
