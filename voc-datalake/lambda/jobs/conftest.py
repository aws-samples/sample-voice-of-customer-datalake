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
    """Mock DynamoDB resource and tables."""
    with patch('shared.aws.get_dynamodb_resource') as mock:
        mock_resource = MagicMock()
        mock_table = MagicMock()
        mock_resource.Table.return_value = mock_table
        mock.return_value = mock_resource
        yield {'resource': mock_resource, 'table': mock_table}


@pytest.fixture
def mock_jobs_table():
    """Mock jobs table for status updates."""
    with patch('shared.tables.get_jobs_table') as mock:
        mock_table = MagicMock()
        mock.return_value = mock_table
        yield mock_table


@pytest.fixture
def mock_bedrock():
    """Mock Bedrock client."""
    with patch('shared.aws.get_bedrock_client') as mock:
        mock_client = MagicMock()
        mock.return_value = mock_client
        yield mock_client


@pytest.fixture
def mock_converse():
    """Mock converse function."""
    with patch('shared.converse.converse') as mock:
        mock.return_value = "Generated content from LLM"
        yield mock


@pytest.fixture
def sample_job_event():
    """Sample job event with common fields."""
    return {
        'project_id': 'proj_20250101120000',
        'job_id': 'job_abc123def456',
    }
