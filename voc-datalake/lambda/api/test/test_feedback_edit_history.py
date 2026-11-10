"""A person's category / dimensions edit keeps the review as it was and says who changed it (TENETS.md D1, D4).

``PUT /feedback/{id}/category`` and ``PUT /feedback/{id}/dimensions`` write the review as it was to
``silver/{source}/{feedback_id}/`` in the raw bucket before the update (``shared/silver_provenance.py``),
and stamp ``updated_by {sub, kind}``, ``updated_at`` and ``change_reason`` (the enrichment provenance stays).
A client sees the stamp's ``kind`` only. Against moto (DynamoDB + S3).
"""
import json
from typing import Any
from unittest.mock import patch

import boto3
import pytest
from feedback_edit_fixtures import ADMIN_CLAIMS, put_category, seeded_tables
from moto_helpers import invoke, rest_event

import feedback_edit_handler
from shared.ai_writing import PLAN_PRINCIPAL_CLAIM
from shared.test.silver_fixtures import kept_versions

BUCKET = 'voc-raw-edit-test'
KEY = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}
DIMENSIONS = [{'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]}]


@pytest.fixture
def tables(monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', BUCKET)
    for feedback, aggregates in seeded_tables():
        aggregates.put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': DIMENSIONS})
        boto3.client('s3', region_name='us-east-1').create_bucket(Bucket=BUCKET)
        yield feedback, aggregates


def _kept() -> list[dict]:
    return kept_versions(BUCKET)


def _put_dimensions(tables: tuple[Any, Any], lambda_context: Any, body: dict) -> tuple[int, Any]:
    feedback, aggregates = tables
    event = rest_event('PUT', '/feedback/f1/dimensions', claims=ADMIN_CLAIMS, body=body, path_params={'id': 'f1'})
    return invoke(feedback_edit_handler, event, lambda_context, feedback=feedback, aggregates=aggregates)


def test_a_category_edit_keeps_the_review_as_it_was(tables, lambda_context):
    status, body = put_category(tables, lambda_context, {'category': 'billing'})
    item = tables[0].get_item(Key=KEY)['Item']
    (kept,) = _kept()

    assert status == 200
    assert kept['item']['category'] == 'delivery'
    assert kept['item']['subcategory'] == 'late'
    assert kept['actor'] == {'sub': 'sub-admin', 'kind': 'admin'}
    assert kept['reason'] == 'category_edit'
    assert {'category', 'gsi2pk', 'subcategory', 'category_override'} <= set(kept['changed_fields'])
    assert 'enrichment_mode' not in kept['changed_fields']
    assert item['updated_by'] == {'sub': 'sub-admin', 'kind': 'admin'}
    assert item['change_reason'] == 'category_edit'
    assert 'enrichment_mode' not in item
    assert item['updated_at'] == item['category_override']['at']
    assert 'sub-admin' not in json.dumps(body)


def test_a_dimensions_edit_records_the_actor_time_and_previous_value(tables, lambda_context):
    """Before 6.03 the dimensions route recorded no actor, time or previous value (audit S3)."""
    _put_dimensions(tables, lambda_context, {'dimensions': {'product': 'App'}, 'tags': ['vip']})
    _put_dimensions(tables, lambda_context, {'dimensions': {'product': 'Web'}})
    item = tables[0].get_item(Key=KEY)['Item']
    kept = sorted(_kept(), key=lambda version: version['kept_at'])

    assert [version['reason'] for version in kept] == ['dimensions_edit', 'dimensions_edit']
    assert 'dimensions' not in kept[0]['item']
    assert kept[1]['item']['dimensions'] == {'product': 'App'}
    assert kept[1]['item']['tags'] == ['vip']
    assert item['dimensions'] == {'product': 'Web'}
    assert item['updated_by'] == {'sub': 'sub-admin', 'kind': 'admin'}
    assert item['change_reason'] == 'dimensions_edit'


def test_a_plan_step_is_told_apart_from_the_person(tables, lambda_context):
    claims = {**ADMIN_CLAIMS, PLAN_PRINCIPAL_CLAIM: 'plan:p1'}
    put_category(tables, lambda_context, {'category': 'billing'}, claims=claims)

    assert tables[0].get_item(Key=KEY)['Item']['updated_by'] == {'sub': 'sub-admin', 'kind': 'plan'}
    assert _kept()[0]['actor']['kind'] == 'plan'


@pytest.mark.parametrize('failure', [RuntimeError('client could not be built'), ValueError('bad')])
def test_a_failed_version_write_never_fails_the_edit(tables, lambda_context, failure):
    with patch('shared.silver_provenance._s3', side_effect=failure):
        status, _ = put_category(tables, lambda_context, {'category': 'billing'})

    assert status == 200
    assert tables[0].get_item(Key=KEY)['Item']['category'] == 'billing'
    assert _kept() == []


def test_a_refused_s3_put_never_fails_the_edit(tables, lambda_context, monkeypatch):
    monkeypatch.setenv('RAW_DATA_BUCKET', 'no-such-bucket')
    status, _ = put_category(tables, lambda_context, {'category': 'billing'})

    assert status == 200
    assert tables[0].get_item(Key=KEY)['Item']['category'] == 'billing'


def test_a_refused_edit_keeps_no_version(tables, lambda_context):
    """A 409 (the review changed meanwhile) records no change that never happened (TENETS.md D4)."""
    feedback = tables[0]
    real_update = feedback.update_item

    def concurrent_edit_first(**kwargs):
        real_update(Key=KEY, UpdateExpression='SET category = :c', ExpressionAttributeValues={':c': 'returns'})
        return real_update(**kwargs)

    with patch.object(feedback, 'update_item', side_effect=concurrent_edit_first):
        status, _ = put_category(tables, lambda_context, {'category': 'billing'})
    assert status == 409
    assert _kept() == []
