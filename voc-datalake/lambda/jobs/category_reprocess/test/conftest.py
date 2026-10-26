"""Fixtures for the category reprocess worker: moto-backed feedback + aggregates
tables, so in-place conditional updates are really evaluated."""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import boto3
import pytest
from moto import mock_aws

from jobs.category_reprocess import handler
from jobs.conftest import *  # noqa: F403
from shared import reprocess_jobs as jobs
from shared.test.moto_tables import create_pk_sk_table

CATEGORIES = [
    {'name': 'shipping', 'description': 'Shipping', 'subcategories': [{'name': 'late'}]},
    {'name': 'billing', 'description': 'Billing'},
]


@pytest.fixture
def tables():
    with mock_aws():
        resource = boto3.resource('dynamodb', region_name='us-east-1')
        feedback = create_pk_sk_table(handler.FEEDBACK_TABLE, resource)
        aggregates = create_pk_sk_table(handler.AGGREGATES_TABLE, resource)
        aggregates.put_item(Item={'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': CATEGORIES})
        with patch('jobs.category_reprocess.handler.get_dynamodb_resource', return_value=resource), \
             patch('shared.categorization.get_active_model_id', return_value='test-model'):
            yield {'feedback': feedback, 'aggregates': aggregates}


@pytest.fixture
def converse_mock():
    mock = MagicMock(return_value='{"category": "shipping", "subcategory": "late"}')
    with patch('shared.categorization.converse', mock):
        yield mock


@pytest.fixture
def invoke_mock():
    mock = MagicMock()
    with patch('jobs.category_reprocess.handler.invoke_lambda_async', mock):
        yield mock


@pytest.fixture
def worker_context():
    context = MagicMock()
    context.function_name = 'voc-job-category-reprocess'
    context.get_remaining_time_in_millis.return_value = 900_000
    return context


@pytest.fixture
def start_job(tables):
    def _start(mode='processed', days=0, include_manual=False):
        return jobs.start_job(
            tables['aggregates'], mode=mode, days=days, include_manual=include_manual,
            started_by='admin', now=datetime.now(UTC),
        )
    return _start

