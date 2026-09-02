"""Test fixtures for document merger job."""

import pytest

# Import shared fixtures
from jobs.conftest import *


@pytest.fixture
def merge_documents_event(sample_job_event):
    """Sample document merge job event."""
    return {
        **sample_job_event,
        'merge_config': {
            'output_type': 'prd',
            'title': 'Merged PRD',
            'instructions': 'Combine the key insights from both documents',
            'selected_document_ids': ['doc_1', 'doc_2'],
            'selected_persona_ids': [],
            'use_feedback': False,
        }
    }


@pytest.fixture
def mock_project_documents():
    """Mock project documents for merging."""
    return [
        {
            'sk': 'PRD#doc_1',
            'document_id': 'doc_1',
            'document_type': 'prd',
            'base_title': 'First PRD',
            'version': 1,
            'title': 'First PRD (v1)',
            'content': 'Content of first PRD...',
        },
        {
            'sk': 'RESEARCH#doc_2',
            'document_id': 'doc_2',
            'document_type': 'research',
            'title': 'Research Report',
            'content': 'Research findings...',
        },
    ]
