"""Fixtures for the retention / erasure worker: moto feedback + aggregates tables
and a versioned raw bucket, so deletes (and every object version) are real."""
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import MagicMock, patch

import boto3
import pytest
from boto3.dynamodb.conditions import Key
from moto import mock_aws

from jobs.retention import handler, runs
from shared.digests import sha256_hex
from shared.test.moto_s3 import create_versioned_bucket
from shared.test.moto_tables import create_pk_sk_table

BUCKET = handler.RAW_DATA_BUCKET or 'test-raw-data-bucket'
RADAR_TABLE = handler.RADAR_TABLE or 'test-radar'
PROJECTS_TABLE = handler.PROJECTS_TABLE or 'test-projects'
FEATURE_REQUESTS_TABLE = handler.FEATURE_REQUESTS_TABLE or 'test-feature-requests'


def days_ago(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def put_feedback(aws: dict[str, Any], feedback_id: str, source: str = 'web', **extra: Any) -> None:
    """One stored review of ``source``, processed yesterday (its ``source_id`` is its id)."""
    aws['feedback'].put_item(Item={'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}',
                                   'feedback_id': feedback_id, 'source_id': feedback_id, 'source_platform': source,
                                   'date': days_ago(1), **extra})


def save_source_profiles(aws: dict[str, Any], *profiles: dict[str, Any]) -> None:
    """The deployment's source profiles (``SETTINGS#sources``), as PUT /settings/sources saves them."""
    aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': list(profiles)})


def queue_erasure_job(aws: dict[str, Any], job_id: str, field: str, value: str, source: str | None = None,
                      **extra: Any) -> dict[str, Any]:
    """An erasure job row as POST /settings/erasure queues it (the value's hash only), and the worker's event."""
    item = {'pk': 'JOB#erasure', 'sk': job_id, 'job_id': job_id, 'status': 'queued', 'field': field,
            'value_hash': sha256_hex(value), **({'source': source} if source else {}), **extra}
    aws['aggregates'].put_item(Item=item)
    return {'mode': 'erase', 'job_id': job_id, 'value': value}


def erasure_job_row(aws: dict[str, Any], job_id: str) -> dict[str, Any]:
    return aws['aggregates'].get_item(Key={'pk': 'JOB#erasure', 'sk': job_id})['Item']


def audit_row(aws: dict[str, Any]) -> dict[str, Any]:
    """The run's one AUDIT#retention row."""
    [row] = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']
    return row


def hand_over_mid_page(event: dict[str, Any], worker_context: Any, invoke_mock: MagicMock) -> dict[str, Any]:
    """Run ``event`` with time for one item, so the worker hands over mid-page; the hand-over's payload."""
    budget = iter([900_000, 0])
    worker_context.get_remaining_time_in_millis.side_effect = lambda: next(budget, 0)
    assert handler.handle_event(event, worker_context)['status'] == 'continued'
    return invoke_mock.call_args.args[1]


@pytest.fixture
def aws():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = create_versioned_bucket(BUCKET)
        feedback = create_pk_sk_table(handler.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        radar = create_pk_sk_table(RADAR_TABLE, resource)
        projects = create_pk_sk_table(PROJECTS_TABLE, resource)
        feature_requests = create_pk_sk_table(FEATURE_REQUESTS_TABLE, resource)
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'get_s3_client', return_value=s3), \
                patch.object(handler, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(handler, 'RADAR_TABLE', RADAR_TABLE), \
                patch.object(handler, 'PROJECTS_TABLE', PROJECTS_TABLE), \
                patch.object(handler, 'FEATURE_REQUESTS_TABLE', FEATURE_REQUESTS_TABLE):
            yield {'feedback': feedback, 'aggregates': aggregates, 'radar': radar, 'projects': projects, 's3': s3,
                   'feature_requests': feature_requests}


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
