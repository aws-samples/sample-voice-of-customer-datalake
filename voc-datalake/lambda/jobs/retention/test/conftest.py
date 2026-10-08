"""Fixtures for the retention / erasure worker: moto feedback + aggregates tables
and a versioned raw bucket, so deletes (and every object version) are real."""
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from jobs.retention import handler
from shared.test.moto_tables import create_pk_sk_table

BUCKET = handler.RAW_DATA_BUCKET or 'test-raw-data-bucket'


def days_ago(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


@pytest.fixture
def aws():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = boto3.client('s3', region_name='us-east-1')
        s3.create_bucket(Bucket=BUCKET)
        s3.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={'Status': 'Enabled'})
        feedback = create_pk_sk_table(handler.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'get_s3_client', return_value=s3), \
                patch.object(handler, 'RAW_DATA_BUCKET', BUCKET):
            yield {'feedback': feedback, 'aggregates': aggregates, 's3': s3}


@pytest.fixture
def invoke_mock():
    mock = MagicMock()
    with patch.object(handler, 'invoke_lambda_async', mock):
        yield mock


@pytest.fixture
def worker_context():
    context = MagicMock()
    context.function_name = 'voc-retention'
    context.get_remaining_time_in_millis.return_value = 900_000
    return context
