"""
Pytest fixtures for research handler tests.
"""
import os
import sys
from decimal import Decimal
from unittest.mock import MagicMock, patch

import boto3
import pytest

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
        mock_projects.name = 'test-projects'

        def transact_write_items(*, TransactItems):
            for action in TransactItems:
                put = action.get('Put')
                if put:
                    mock_projects.put_item(Item=put['Item'])
                update = action.get('Update')
                if update:
                    mock_projects.update_item(
                        Key=update['Key'],
                        UpdateExpression=update['UpdateExpression'],
                        ExpressionAttributeValues=update.get(
                            'ExpressionAttributeValues', {},
                        ),
                    )
            return {}

        mock_projects.meta.client.transact_write_items.side_effect = (
            transact_write_items
        )
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


@pytest.fixture
def saved_research_table():
    """A real DynamoDB projects table for the save step.

    ``step_save`` now writes through ``shared.document_versions``, whose
    allocation is one ``transact_write_items`` over a version counter, an
    allocation row, the document and the project's ``document_count``. A
    MagicMock table can echo the request shape but cannot honour the condition
    expressions those four writes depend on, so the version and title a save
    produces would not be proven by one. moto runs the transaction for real.

    Yields the boto3 Table; ``research_document`` reads the stored row back.
    """
    from moto import mock_aws

    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-projects',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        table.put_item(Item={
            'pk': 'PROJECT#p1',
            'sk': 'META',
            'project_id': 'p1',
            'document_count': 0,
        })
        table.put_item(Item={
            'pk': 'PROJECT#proj_1',
            'sk': 'META',
            'project_id': 'proj_1',
            'document_count': 0,
        })
        with patch(
            'research_step_handler._get_projects_table', return_value=table,
        ), patch(
            'research_step_handler._get_feedback_table', return_value=MagicMock(),
        ):
            yield table


def research_document(table, project_id: str = 'p1') -> dict:
    """The one RESEARCH# row a save step wrote, read back from the table."""
    from boto3.dynamodb.conditions import Key

    items = table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}'),
        ConsistentRead=True,
    )['Items']
    documents = [
        item for item in items
        if str(item.get('sk', '')).startswith('RESEARCH#')
    ]
    assert len(documents) == 1, f'expected one research row, got {len(documents)}'
    return documents[0]
