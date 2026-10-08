"""PUT /data-explorer/feedback: a category change follows the same rules as
PUT /feedback/{id}/category (shared.feedback_category), and no edit can ever
create an item (moto-backed, so the DynamoDB conditions really run)."""
from unittest.mock import patch

import boto3
import pytest
from category_access_fixtures import CATEGORIES_CONFIG
from moto import mock_aws
from moto_helpers import CATEGORY_EDIT_ADMIN_CLAIMS as ADMIN_CLAIMS
from moto_helpers import CATEGORY_EDIT_ITEM as ITEM
from moto_helpers import invoke, rest_event, seeded_category_edit_tables

import data_explorer_handler

PATH = '/data-explorer/feedback'


@pytest.fixture
def tables():
    with mock_aws():
        feedback, aggregates = seeded_category_edit_tables(ITEM, CATEGORIES_CONFIG)
        with patch.object(data_explorer_handler, 'dynamodb', boto3.resource('dynamodb', region_name='us-east-1')), \
                patch.object(data_explorer_handler, 'FEEDBACK_TABLE', 'feedback'):
            yield feedback, aggregates


def _save(tables, lambda_context, data, feedback_id='f1'):
    event = rest_event('PUT', PATH, claims=ADMIN_CLAIMS, body={'feedback_id': feedback_id, 'data': data})
    return invoke(data_explorer_handler, event, lambda_context, aggregates=tables[1])


def _stored(tables):
    return tables[0].get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})['Item']


def _racing(tables, mutate):
    """Patch the handler's read so ``mutate(table, key)`` runs between its read and its write."""
    real_read = data_explorer_handler._stored_item

    def read_then_mutate(table, key):
        item = real_read(table, key)
        mutate(tables[0], key)
        return item

    return patch.object(data_explorer_handler, '_stored_item', side_effect=read_then_mutate)


def test_category_change_moves_gsi2pk_and_is_audited(tables, lambda_context):
    status, _ = _save(tables, lambda_context, {**ITEM, 'category': 'billing', 'subcategory': ''})
    assert status == 200
    stored = _stored(tables)
    assert stored['category'] == 'billing'
    assert stored['gsi2pk'] == 'CATEGORY#billing'
    assert stored['gsi2sk'] == ITEM['gsi2sk']
    assert stored['category_source'] == 'manual'
    assert 'subcategory' not in stored
    override = stored['category_override']
    assert override['previous_category'] == 'delivery'
    assert override['previous_subcategory'] == 'late'
    assert override['by_sub'] == 'sub-admin'
    assert override['by_username'] == 'ada'


def test_unchanged_category_is_not_a_manual_change(tables, lambda_context):
    status, _ = _save(tables, lambda_context, {**ITEM, 'original_text': 'edited'})
    assert status == 200
    stored = _stored(tables)
    assert stored['original_text'] == 'edited'
    assert 'category_source' not in stored
    assert 'category_override' not in stored


def test_concurrent_category_change_is_409(tables, lambda_context):
    def recategorise(table, key):
        table.update_item(Key=key, UpdateExpression='SET category = :c', ExpressionAttributeValues={':c': 'app'})

    with _racing(tables, recategorise):
        status, _ = _save(tables, lambda_context, {'category': 'billing'})
    assert status == 409
    assert _stored(tables)['category'] == 'app'


def test_an_edit_never_creates_an_item(tables, lambda_context):
    """A key built from `source_platform` for an id that does not exist must not upsert."""
    status, _ = _save(tables, lambda_context, {'source_platform': 'ghost', 'original_text': 'x'}, feedback_id='nope')
    assert status == 404
    assert 'Item' not in tables[0].get_item(Key={'pk': 'SOURCE#ghost', 'sk': 'FEEDBACK#nope'})


def test_every_update_is_conditional_on_existence(tables, lambda_context):
    """Even when the item vanishes between the read and the write."""
    with _racing(tables, lambda table, key: table.delete_item(Key=key)):
        status, _ = _save(tables, lambda_context, {'original_text': 'x'})
    assert status == 404
    assert 'Item' not in tables[0].get_item(Key={'pk': ITEM['pk'], 'sk': ITEM['sk']})
