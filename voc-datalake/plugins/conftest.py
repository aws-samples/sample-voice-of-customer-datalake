"""
Root conftest for all plugin tests.
Sets up paths before any imports happen.
"""
import os
import sys

# Add lambda directory to path for shared module imports FIRST
# This must happen before any plugin modules are imported
lambda_dir = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'lambda'
)
plugins_dir = os.path.dirname(os.path.abspath(__file__))

# Insert at beginning of path
sys.path.insert(0, lambda_dir)
sys.path.insert(0, plugins_dir)

# Set environment variables BEFORE any imports
os.environ.setdefault('WATERMARKS_TABLE', 'test-watermarks')
os.environ.setdefault('PROCESSING_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456789/test-queue')
os.environ.setdefault('RAW_DATA_BUCKET', '')
os.environ.setdefault('SECRETS_ARN', 'arn:aws:secretsmanager:us-east-1:123456789:secret:test')
os.environ.setdefault('BRAND_NAME', 'TestBrand')
os.environ.setdefault('BRAND_HANDLES', '["@testbrand", "testbrand"]')
os.environ.setdefault('SOURCE_PLATFORM', 'test_source')
os.environ.setdefault('AWS_DEFAULT_REGION', 'us-east-1')
os.environ.setdefault('POWERTOOLS_SERVICE_NAME', 'test-service')
os.environ.setdefault('POWERTOOLS_METRICS_NAMESPACE', 'TestVoC')
os.environ.setdefault('CIRCUIT_BREAKER_THRESHOLD', '3')
os.environ.setdefault('CIRCUIT_BREAKER_WINDOW', '5')
os.environ.setdefault('AUDIT_EVENT_BUS', '')
os.environ.setdefault('WEBHOOK_SECRET', 'test-webhook-secret')
