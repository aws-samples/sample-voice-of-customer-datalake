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
from shared.retention import ERASURE_JOB_PK
from shared.test.moto_s3 import create_versioned_bucket
from shared.test.moto_tables import (
    create_feedback_table_by_date_and_id,
    create_pk_sk_table,
    create_projects_table_with_type_index,
    mark_review_registries_backfilled,
)

BUCKET = handler.RAW_DATA_BUCKET or 'test-raw-data-bucket'
RADAR_TABLE = handler.RADAR_TABLE or 'test-radar'
PROJECTS_TABLE = handler.PROJECTS_TABLE or 'test-projects'
FEATURE_REQUESTS_TABLE = handler.FEATURE_REQUESTS_TABLE or 'test-feature-requests'
WORKSPACES_TABLE = handler.WORKSPACES_TABLE or 'test-workspaces'


def days_ago(days: int) -> str:
    return (datetime.now(UTC).date() - timedelta(days=days)).isoformat()


def put_feedback(aws: dict[str, Any], feedback_id: str, source: str = 'web', **extra: Any) -> None:
    """One stored review of ``source``, processed yesterday (its ``source_id`` is its id)."""
    aws['feedback'].put_item(Item={'pk': f'SOURCE#{source}', 'sk': f'FEEDBACK#{feedback_id}',
                                   'feedback_id': feedback_id, 'source_id': feedback_id, 'source_platform': source,
                                   'date': days_ago(1), **extra})


def raw_keys(aws: dict[str, Any]) -> set[str]:
    """Every key in the raw bucket that still has a version holding data."""
    page = aws['s3'].list_object_versions(Bucket=BUCKET)
    return {entry['Key'] for entry in page.get('Versions', [])}


def erasure_job(aws: dict[str, Any], job_id: str, field: str, value: str, **row: Any) -> dict[str, Any]:
    """A queued erasure job row (its ``row`` fields, None left out), and the invoke event that runs it."""
    item = {'pk': ERASURE_JOB_PK, 'sk': job_id, 'job_id': job_id, 'status': 'queued', 'field': field,
            'value_hash': sha256_hex(value)}
    item.update({name: given for name, given in row.items() if given is not None})
    aws['aggregates'].put_item(Item=item)
    return {'mode': 'erase', 'job_id': job_id, 'value': value}


def erasure_rows(aws: dict[str, Any], job_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """``(job row, the one audit row)`` after a run."""
    job = aws['aggregates'].get_item(Key={'pk': ERASURE_JOB_PK, 'sk': job_id})['Item']
    audits = aws['aggregates'].query(KeyConditionExpression=Key('pk').eq(runs.AUDIT_PK))['Items']
    assert len(audits) == 1
    return job, audits[0]


@pytest.fixture
def aws():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        s3 = create_versioned_bucket(BUCKET)
        # With gsi1-by-date and gsi4-by-feedback-id, as core-stack.ts: a workspace's erasure finds its items by them
        # (7.96.00, item_walk.py); a row without their keys is on neither, as in DynamoDB.
        feedback = create_feedback_table_by_date_and_id(handler.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        radar = create_pk_sk_table(RADAR_TABLE, resource)
        # With gsi1-by-type, as core-stack.ts (the stores write it; the deployment's walks read PROJECT_IDS, 7.48.00).
        projects = create_projects_table_with_type_index(PROJECTS_TABLE, resource)
        # A backfilled deployment (7.93.00, 3g-d2: the deployment's walks require the marker; a test of the refusal
        # deletes it).
        mark_review_registries_backfilled(projects)
        feature_requests = create_pk_sk_table(FEATURE_REQUESTS_TABLE, resource)
        workspaces = create_pk_sk_table(WORKSPACES_TABLE, resource)
        with patch.object(handler, 'get_dynamodb_resource', return_value=resource), \
                patch.object(handler, 'get_s3_client', return_value=s3), \
                patch.object(handler, 'RAW_DATA_BUCKET', BUCKET), \
                patch.object(handler, 'RADAR_TABLE', RADAR_TABLE), \
                patch.object(handler, 'PROJECTS_TABLE', PROJECTS_TABLE), \
                patch.object(handler, 'FEATURE_REQUESTS_TABLE', FEATURE_REQUESTS_TABLE), \
                patch.object(handler, 'WORKSPACES_TABLE', WORKSPACES_TABLE):
            yield {'feedback': feedback, 'aggregates': aggregates, 'radar': radar, 'projects': projects, 's3': s3,
                   'feature_requests': feature_requests, 'workspaces': workspaces}


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


@pytest.fixture
def three_a_page():
    """Pages of three rows, so a few items make several pages."""
    with patch.object(handler, 'PAGE_SIZE', 3):
        yield
