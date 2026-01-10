"""
Root pytest configuration for Lambda tests.

This conftest sets up the environment consistently for all tests,
preventing conflicts between different test directories.
"""
import os
import sys

# Remove any layers directories from sys.path to avoid importing
# incomplete packages (missing compiled extensions like pydantic_core)
sys.path = [p for p in sys.path if 'lambda/layers' not in p and 'layers/' not in p]

# Set environment variables BEFORE any module imports
# These are the common environment variables needed by all handlers
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-east-1')
os.environ.setdefault('POWERTOOLS_SERVICE_NAME', 'test-voc')
os.environ.setdefault('POWERTOOLS_METRICS_NAMESPACE', 'TestVoC')
os.environ.setdefault('FEEDBACK_TABLE', 'test-feedback')
os.environ.setdefault('AGGREGATES_TABLE', 'test-aggregates')
os.environ.setdefault('CONVERSATIONS_TABLE', 'test-conversations')
os.environ.setdefault('PROJECTS_TABLE', 'test-projects')
os.environ.setdefault('JOBS_TABLE', 'test-jobs')
os.environ.setdefault('ALLOWED_ORIGIN', 'http://localhost:5173')
os.environ.setdefault('SECRETS_ARN', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:test-secrets')
os.environ.setdefault('RAW_DATA_BUCKET', 'test-raw-data-bucket')
os.environ.setdefault('ARTIFACT_BUILDER_BUCKET', 'test-artifact-builder-bucket')
os.environ.setdefault('PROCESSING_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue')
os.environ.setdefault('USER_POOL_ID', 'us-east-1_testpool')

# Add lambda directory to path for shared module imports
lambda_dir = os.path.dirname(os.path.abspath(__file__))
if lambda_dir not in sys.path:
    sys.path.insert(0, lambda_dir)
