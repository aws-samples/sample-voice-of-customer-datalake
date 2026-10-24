"""
Pytest fixtures for research handler tests.
"""
import os
import sys
from unittest.mock import MagicMock, patch

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


@pytest.fixture(autouse=True)
def model_window():
    """Pin the 'documents' surface's context window, so sizing the research
    feedback budget never reads the model settings table (#231)."""
    from shared.feedback import DEFAULT_CONTEXT_WINDOW_TOKENS
    with patch('research_step_handler.surface_context_window_tokens',
               return_value=DEFAULT_CONTEXT_WINDOW_TOKENS) as m:
        yield m


@pytest.fixture(autouse=True)
def no_company_knowledge():
    """No test reads company context or memories from a real table: the shared
    grounding answers empty unless a test patches it (test_research_knowledge.py)."""
    from shared.grounding import Grounding
    with patch('research_step_handler.shared_grounding', return_value=Grounding()) as grounding:
        yield grounding


def install_fake_transact_writes(mock_projects: MagicMock) -> None:
    """Make the projects table double's ``transact_write_items`` replay each
    Put/Update as a plain ``put_item``/``update_item`` call on the same double,
    so a test can assert on the writes a transaction carried."""
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

    mock_projects.meta.client.transact_write_items.side_effect = transact_write_items


class FakeScratchS3:
    """The S3 calls the research claim-check makes, against an in-memory store."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}
        self.deleted: list[tuple[str, str]] = []

    def put_object(self, *, Bucket: str, Key: str, Body: bytes) -> dict:
        self.objects[(Bucket, Key)] = Body
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        if (Bucket, Key) not in self.objects:
            raise KeyError(f'NoSuchKey: {Key}')
        body = MagicMock()
        body.read.return_value = self.objects[(Bucket, Key)]
        return {'Body': body}

    def delete_object(self, *, Bucket: str, Key: str) -> dict:
        self.objects.pop((Bucket, Key), None)
        self.deleted.append((Bucket, Key))
        return {}


@pytest.fixture(autouse=True)
def scratch_s3():
    """Every research test gets the in-memory scratch bucket, so no step reaches real S3.

    The bucket name is patched on the module, never set in os.environ: the env is
    process-wide and other suites read their own RAW_DATA_BUCKET from it.
    """
    fake = FakeScratchS3()
    with patch('research_step_handler.get_s3_client', return_value=fake), \
            patch('research_step_handler.SCRATCH_BUCKET', 'test-raw'):
        yield fake


@pytest.fixture
def mock_tables():
    """Feedback and projects table doubles behind the handler's lazy getters."""
    mock_fb = MagicMock()
    mock_proj = MagicMock()
    mock_proj.name = 'test-projects'
    install_fake_transact_writes(mock_proj)
    with patch('research_step_handler._get_feedback_table', return_value=mock_fb), \
         patch('research_step_handler._get_projects_table', return_value=mock_proj):
        yield {'feedback': mock_fb, 'projects': mock_proj}


@pytest.fixture
def mock_job_status():
    """Mock update_job_status."""
    with patch('research_step_handler.update_job_status') as m:
        yield m


@pytest.fixture
def lambda_context():
    """Mock Lambda context for handler tests."""
    context = MagicMock(
        log_group_name='/aws/lambda/test-research-step',
        log_stream_name='2026/01/09/[$LATEST]test',
    )
    context.function_name = 'test-research-step'
    context.memory_limit_in_mb = 1024
    context.invoked_function_arn = 'arn:aws:lambda:us-west-2:123456789012:function:test-research-step'
    context.aws_request_id = 'test-request-id-12345'
    context.get_remaining_time_in_millis = lambda: 300000
    return context
