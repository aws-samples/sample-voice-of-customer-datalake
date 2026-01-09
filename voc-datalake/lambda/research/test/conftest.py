"""
Pytest fixtures for research handler tests.
"""
import os
import sys
import pytest
from unittest.mock import MagicMock, patch
from decimal import Decimal

# Add research module and shared module to path
research_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lambda_dir = os.path.dirname(research_dir)

# Insert at the beginning to ensure our modules take precedence
if research_dir not in sys.path:
    sys.path.insert(0, research_dir)
if lambda_dir not in sys.path:
    sys.path.insert(0, lambda_dir)

# Set environment variables before importing modules
os.environ['AWS_DEFAULT_REGION'] = 'us-west-2'
os.environ['POWERTOOLS_SERVICE_NAME'] = 'test-research'
os.environ['FEEDBACK_TABLE'] = 'test-feedback'
os.environ['PROJECTS_TABLE'] = 'test-projects'
os.environ['JOBS_TABLE'] = 'test-jobs'


@pytest.fixture
def mock_dynamodb_tables():
    """Mock DynamoDB tables."""
    with patch('research_step_handler.feedback_table') as mock_feedback, \
         patch('research_step_handler.projects_table') as mock_projects, \
         patch('research_step_handler.jobs_table') as mock_jobs:
        yield {
            'feedback': mock_feedback,
            'projects': mock_projects,
            'jobs': mock_jobs
        }


@pytest.fixture
def mock_bedrock():
    """Mock Bedrock client."""
    with patch('research_step_handler.bedrock') as mock:
        yield mock


@pytest.fixture
def sample_feedback_items():
    """Sample feedback items for testing."""
    return [
        {
            'pk': 'SOURCE#test',
            'sk': 'FEEDBACK#1',
            'source_platform': 'test_source',
            'source_created_at': '2026-01-01T00:00:00Z',
            'sentiment_label': 'positive',
            'sentiment_score': Decimal('0.95'),
            'category': 'customer_service',
            'rating': Decimal('5'),
            'urgency': 'low',
            'original_text': 'Great service!',
            'direct_customer_quote': 'Great service!',
        },
        {
            'pk': 'SOURCE#test',
            'sk': 'FEEDBACK#2',
            'source_platform': 'test_source',
            'source_created_at': '2026-01-02T00:00:00Z',
            'sentiment_label': 'negative',
            'sentiment_score': Decimal('-0.80'),
            'category': 'delivery',
            'rating': Decimal('1'),
            'urgency': 'high',
            'original_text': 'Late delivery, very disappointed.',
            'direct_customer_quote': 'Late delivery',
            'problem_summary': 'Delivery was late',
            'problem_root_cause_hypothesis': 'Logistics issues',
        },
    ]


@pytest.fixture
def research_event():
    """Sample research event for testing."""
    return {
        'step': 'initialize',
        'project_id': 'proj_test123',
        'job_id': 'job_test456',
        'research_config': {
            'question': 'What are the main customer pain points?',
            'title': 'Test Research',
            'sources': [],
            'categories': [],
            'sentiments': [],
            'days': 30,
            'selected_persona_ids': [],
            'selected_document_ids': [],
        }
    }


@pytest.fixture
def mock_bedrock_response():
    """Mock successful Bedrock response."""
    import json
    import io
    
    response_body = {
        'content': [{'text': 'This is a test AI response with analysis.'}]
    }
    
    mock_response = MagicMock()
    mock_response.__getitem__ = lambda self, key: {
        'body': io.BytesIO(json.dumps(response_body).encode())
    }[key]
    
    return mock_response


@pytest.fixture
def lambda_context():
    """Mock Lambda context for handler tests."""
    context = MagicMock()
    context.function_name = 'test-research-step'
    context.memory_limit_in_mb = 1024
    context.invoked_function_arn = 'arn:aws:lambda:us-west-2:123456789012:function:test-research-step'
    context.aws_request_id = 'test-request-id-12345'
    context.log_group_name = '/aws/lambda/test-research-step'
    context.log_stream_name = '2026/01/09/[$LATEST]test'
    context.get_remaining_time_in_millis = lambda: 300000
    return context
