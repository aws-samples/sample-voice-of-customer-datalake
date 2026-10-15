"""Test fixtures for persona generator job."""

import pytest
from unittest.mock import patch, MagicMock

# Import shared fixtures
from jobs.conftest import *  # noqa: F401, F403


@pytest.fixture
def mock_generate_personas():
    """Mock the generate_personas function where it's used in the handler.

    The handler module is imported HERE, before either patch is entered, and that
    ordering is load-bearing. ``patch`` resolves its target by importing the named
    module: with ``api.projects.generate_personas`` already patched, first-importing
    ``jobs.persona_generator.handler`` runs its ``from api.projects import
    generate_personas`` against the live patch, so the handler binds the mock. The
    second patcher then records the MOCK as the attribute's original value and
    faithfully restores it on teardown — leaving ``generate_personas`` permanently
    stubbed for every later test in the session, with no failure to point at the
    cause. That is what happened: every test in test_handler.py after the first
    user of this fixture ran against a stale mock.

    ``create=True`` is also gone. The attribute does exist, and the flag only
    served to suppress the AttributeError that would have named this mistake.
    """
    import jobs.persona_generator.handler  # noqa: F401  (bind the real function first)

    mock = MagicMock(return_value={
        'success': True,
        'personas': [
            {'persona_id': 'persona_1', 'name': 'Test Persona 1'},
            {'persona_id': 'persona_2', 'name': 'Test Persona 2'},
        ],
        'metadata': {'feedback_count': 50}
    })
    with patch('api.projects.generate_personas', mock), \
         patch('jobs.persona_generator.handler.generate_personas', mock):
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
