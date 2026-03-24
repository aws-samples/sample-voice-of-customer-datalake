"""Shared test fixtures for job Lambda handlers."""

import os
import sys
import pytest
from unittest.mock import MagicMock, patch

# Add lambda directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set required environment variables before importing handlers
os.environ.setdefault('PROJECTS_TABLE', 'test-projects-table')
os.environ.setdefault('FEEDBACK_TABLE', 'test-feedback-table')
os.environ.setdefault('JOBS_TABLE', 'test-jobs-table')
os.environ.setdefault('AGGREGATES_TABLE', 'test-aggregates-table')
os.environ.setdefault('RAW_DATA_BUCKET', 'test-raw-data-bucket')
os.environ.setdefault('AVATARS_CDN_URL', 'https://cdn.example.com/avatars')


@pytest.fixture
def mock_dynamodb():
    """Mock DynamoDB resource and tables where used in handler modules."""
    mock_resource = MagicMock()
    mock_table = MagicMock()
    mock_resource.Table.return_value = mock_table
    patchers = [
        patch('shared.aws.get_dynamodb_resource', return_value=mock_resource),
    ]
    # Also patch at handler module level for already-imported modules
    for module_path in [
        'jobs.document_generator.handler.get_dynamodb_resource',
        'jobs.document_merger.handler.get_dynamodb_resource',
        'jobs.persona_importer.handler.get_dynamodb_resource',
    ]:
        patchers.append(patch(module_path, return_value=mock_resource, create=True))
    for p in patchers:
        p.start()
    yield {'resource': mock_resource, 'table': mock_table}
    for p in patchers:
        p.stop()


@pytest.fixture
def mock_jobs_table():
    """Mock jobs table for status updates."""
    mock_table = MagicMock()
    with patch('shared.tables.get_jobs_table', return_value=mock_table), \
         patch('shared.jobs.get_jobs_table', return_value=mock_table, create=True):
        yield mock_table


@pytest.fixture
def mock_bedrock():
    """Mock Bedrock client where it's used in handler modules."""
    mock_client = MagicMock()
    patchers = [
        patch('shared.aws.get_bedrock_client', return_value=mock_client),
    ]
    # Also patch at handler module level for already-imported modules
    for module_path in [
        'jobs.persona_importer.handler.get_bedrock_client',
    ]:
        patchers.append(patch(module_path, return_value=mock_client, create=True))
    for p in patchers:
        p.start()
    yield mock_client
    for p in patchers:
        p.stop()


@pytest.fixture
def mock_converse():
    """Mock converse function where it's used in handler modules.
    
    Handlers use `from shared.converse import converse`, creating a local binding.
    We must patch at the handler module level so the local reference is replaced.
    """
    mock = MagicMock(return_value="Generated content from LLM")
    patchers = [
        patch('shared.converse.converse', mock),
    ]
    # Also patch at handler module level for already-imported modules
    for module_path in [
        'jobs.document_generator.handler.converse',
        'jobs.document_merger.handler.converse',
    ]:
        patchers.append(patch(module_path, mock, create=True))
    for p in patchers:
        p.start()
    yield mock
    for p in patchers:
        p.stop()


@pytest.fixture
def sample_job_event():
    """Sample job event with common fields."""
    return {
        'project_id': 'proj_20250101120000',
        'job_id': 'job_abc123def456',
    }
