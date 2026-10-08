"""Tests for feedback_edit_handler.py — PUT /feedback/{id}/category (moto-backed)."""
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from category_access_fixtures import CATEGORIES_CONFIG, RESTRICTED_CLAIMS, RESTRICTED_SUB
from feedback_edit_fixtures import ITEM, put_category, seeded_tables

from shared.category_access import access_key


@pytest.fixture
def tables():
    yield from seeded_tables()


_put = put_category


def _stored(tables):
    return tables[0].get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})['Item']


def test_moves_the_item_in_place_and_records_the_override(tables, lambda_context):
    status, body = _put(tables, lambda_context, {'category': 'billing'})
    assert status == 200
    assert body['success'] is True
    feedback = body['feedback']
    assert feedback['category'] == 'billing'
    assert feedback['subcategory'] is None
    assert feedback['category_source'] == 'manual'
    override = feedback['category_override']
    assert override['previous_category'] == 'delivery'
    assert override['previous_subcategory'] == 'late'
    assert override['by_username'] == 'ada'
    # The editor's Cognito subject is stored for audit but never returned.
    assert set(override) == {'previous_category', 'previous_subcategory', 'by_username', 'at'}
    stored = _stored(tables)
    assert stored['category_override']['by_sub'] == 'sub-admin'
    assert stored['gsi2pk'] == 'CATEGORY#billing'
    assert stored['gsi2sk'] == ITEM['gsi2sk']
    assert 'subcategory' not in stored


def test_sets_a_subcategory_when_given(tables, lambda_context):
    _, aggregates = tables
    aggregates.put_item(Item={**CATEGORIES_CONFIG, 'categories': [
        {'name': 'delivery'}, {'name': 'billing', 'subcategories': [{'name': 'refund'}]}]})
    status, body = _put(tables, lambda_context, {'category': 'billing', 'subcategory': 'refund'})
    assert status == 200
    assert body['feedback']['subcategory'] == 'refund'
    status, _ = _put(tables, lambda_context, {'category': 'billing', 'subcategory': 'nope'})
    assert status == 400


def test_restricted_caller_needs_both_categories(tables, lambda_context):
    _, aggregates = tables
    aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['delivery']})
    status, _ = _put(tables, lambda_context, {'category': 'billing'}, claims=RESTRICTED_CLAIMS)
    assert status == 404
    aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['billing']})
    status, _ = _put(tables, lambda_context, {'category': 'billing'}, claims=RESTRICTED_CLAIMS)
    assert status == 404
    aggregates.put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['billing', 'delivery']})
    status, body = _put(tables, lambda_context, {'category': 'billing'}, claims=RESTRICTED_CLAIMS)
    assert status == 200
    assert 'by_sub' not in body['feedback']['category_override']
    assert _stored(tables)['category_override']['by_sub'] == RESTRICTED_SUB


def test_concurrent_change_is_409(tables, lambda_context):
    feedback, _ = tables
    real_update = feedback.update_item

    def race(**kwargs):
        feedback.put_item(Item={**ITEM, 'category': 'app'})  # someone else moved it
        return real_update(**kwargs)

    with patch.object(type(feedback), 'update_item', side_effect=race, autospec=False):
        status, _ = _put(tables, lambda_context, {'category': 'billing'})
    assert status == 409
    assert _stored(tables)['category'] == 'app'


def test_other_write_failures_are_500(tables, lambda_context):
    feedback, _ = tables
    error = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'UpdateItem')
    with patch.object(type(feedback), 'update_item', side_effect=error, autospec=False):
        status, _ = _put(tables, lambda_context, {'category': 'billing'})
    assert status == 500
