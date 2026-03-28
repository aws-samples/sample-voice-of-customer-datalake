"""Test fixtures for persona importer job."""

import pytest
from unittest.mock import patch, MagicMock

# Import shared fixtures
from jobs.conftest import *  # noqa: F401, F403


@pytest.fixture
def text_import_event(sample_job_event):
    """Sample text-based persona import job event."""
    return {
        **sample_job_event,
        'import_config': {
            'input_type': 'text',
            'content': '''
            Name: Sarah Chen
            Role: Product Manager at a mid-size tech company
            
            Goals:
            - Ship features faster
            - Better understand customer needs
            - Reduce time spent on documentation
            
            Frustrations:
            - Too many meetings
            - Scattered feedback across tools
            - Hard to prioritize features
            ''',
            'media_type': '',
        }
    }


@pytest.fixture
def image_import_event(sample_job_event):
    """Sample image-based persona import job event."""
    # Base64 encoded 1x1 PNG (minimal valid image)
    minimal_png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    return {
        **sample_job_event,
        'import_config': {
            'input_type': 'image',
            'content': minimal_png,
            'media_type': 'image/png',
        }
    }


@pytest.fixture
def mock_bedrock_persona_response():
    """Mock Bedrock response with extracted persona data."""
    return {
        'output': {
            'message': {
                'content': [{
                    'text': '''{
                        "name": "Sarah Chen",
                        "tagline": "Efficiency-focused PM seeking better tools",
                        "confidence": "high",
                        "identity": {"role": "Product Manager", "company_size": "mid-size"},
                        "goals_motivations": {"primary": ["Ship faster", "Understand customers"]},
                        "pain_points": {"primary": ["Too many meetings", "Scattered feedback"]},
                        "behaviors": {},
                        "context_environment": {},
                        "quotes": ["I spend too much time in meetings"],
                        "scenario": {}
                    }'''
                }]
            }
        }
    }


@pytest.fixture
def mock_avatar_generation():
    """Mock avatar generation function where it's used in the handler."""
    mock = MagicMock(return_value={
        'avatar_url': 's3://test-bucket/avatars/test.png',
        'avatar_prompt': 'Professional headshot of Sarah Chen'
    })
    with patch('api.projects.generate_persona_avatar', mock), \
         patch('jobs.persona_importer.handler.generate_persona_avatar', mock, create=True):
        yield mock
