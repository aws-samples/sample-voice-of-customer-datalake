"""PUT /feedback/{id}/dimensions (feedback_edit_handler), against moto."""
from typing import Any
from unittest.mock import patch

import pytest
from boto3.dynamodb.conditions import ConditionExpressionBuilder
from botocore.exceptions import ClientError
from category_access_fixtures import RESTRICTED_CLAIMS, RESTRICTED_SUB
from feedback_edit_fixtures import ADMIN_CLAIMS, seeded_tables
from moto_helpers import invoke, rest_event

import feedback_edit_handler
from shared.category_access import access_key

DIMENSIONS = [
    {'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]},
    {'key': 'module', 'label': 'Module', 'parent': 'product',
     'values': [{'name': 'checkout', 'parent_value': 'App'}]},
]
KEY = {'pk': 'SOURCE#web', 'sk': 'FEEDBACK#f1'}


@pytest.fixture
def tables():
    for feedback, aggregates in seeded_tables():
        aggregates.put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': DIMENSIONS})
        yield feedback, aggregates


def put(tables: tuple[Any, Any], lambda_context: Any, body: object, claims: dict = ADMIN_CLAIMS,
        feedback_id: str = 'f1') -> tuple[int, Any]:
    feedback, aggregates = tables
    event = rest_event('PUT', f'/feedback/{feedback_id}/dimensions', claims=claims, body=body,
                       path_params={'id': feedback_id})
    return invoke(feedback_edit_handler, event, lambda_context, feedback=feedback, aggregates=aggregates)


def _stored(tables) -> dict:
    return tables[0].get_item(Key=KEY)['Item']


def test_sets_manual_values_and_tags(tables, lambda_context):
    status, body = put(tables, lambda_context, {'dimensions': {'product': 'app', 'module': 'checkout'},
                                                'tags': ['VIP', 'vip', 'beta']})
    assert status == 200
    assert body == {'success': True, 'feedback_id': 'f1',
                    'dimensions': {'product': 'App', 'module': 'checkout'}, 'tags': ['VIP', 'beta']}
    item = _stored(tables)
    assert item['dimension_sources'] == {'product': 'manual', 'module': 'manual'}
    assert item['category'] == 'delivery'


def test_null_removes_and_an_orphaned_child_is_dropped(tables, lambda_context):
    put(tables, lambda_context, {'dimensions': {'product': 'App', 'module': 'checkout'}})
    status, body = put(tables, lambda_context, {'dimensions': {'product': None}})
    assert status == 200
    assert body['dimensions'] == {}
    item = _stored(tables)
    assert 'dimensions' not in item
    assert 'dimension_sources' not in item


def test_tags_alone_keep_the_dimensions(tables, lambda_context):
    put(tables, lambda_context, {'dimensions': {'product': 'Web'}})
    status, body = put(tables, lambda_context, {'tags': []})
    assert status == 200
    assert body == {'success': True, 'feedback_id': 'f1', 'dimensions': {'product': 'Web'}, 'tags': []}
    assert 'tags' not in _stored(tables)


@pytest.mark.parametrize('body', [
    {}, [], {'dimensions': []}, {'dimensions': {'colour': 'red'}}, {'dimensions': {'product': 'Tablet'}},
    {'dimensions': {'module': 'checkout'}, 'tags': ['ok']}, {'tags': ['a#b']}, {'tags': 'vip'},
])
def test_invalid_bodies_are_400(tables, lambda_context, body):
    status, _ = put(tables, lambda_context, body)
    assert status == 400


def test_an_unknown_review_is_404(tables, lambda_context):
    status, _ = put(tables, lambda_context, {'tags': ['x']}, feedback_id='missing')
    assert status == 404


def test_a_review_outside_the_callers_scope_is_404(tables, lambda_context):
    tables[1].put_item(Item={**access_key(RESTRICTED_SUB), 'categories': ['billing']})
    status, _ = put(tables, lambda_context, {'tags': ['x']}, claims=RESTRICTED_CLAIMS)
    assert status == 404
    assert 'tags' not in _stored(tables)


def test_a_concurrent_change_is_409(tables, lambda_context):
    error = ClientError({'Error': {'Code': 'ConditionalCheckFailedException'}}, 'UpdateItem')
    with patch.object(tables[0], 'update_item', side_effect=error):
        status, _ = put(tables, lambda_context, {'tags': ['x']})
    assert status == 409


def test_the_update_is_conditional_on_what_was_read():
    item = {**KEY, 'dimensions': {'product': 'App'}, 'tags': ['a']}
    kwargs = feedback_edit_handler._dimensions_update_kwargs(item, {}, {}, ['a'])
    assert kwargs['UpdateExpression'] == 'SET #t = :t REMOVE #d, #ds'
    built = ConditionExpressionBuilder().build_expression(kwargs['ConditionExpression'])
    names = set(built.attribute_name_placeholders.values())
    assert names == {'pk', 'dimensions', 'dimension_sources', 'tags'}
    assert built.condition_expression.count('attribute_not_exists') == 1
    assert {'product': 'App'} in built.attribute_value_placeholders.values()


def test_a_corrupt_dimensions_row_is_500(tables, lambda_context):
    tables[1].put_item(Item={'pk': 'SETTINGS#dimensions', 'sk': 'config', 'dimensions': 'corrupt'})
    status, _ = put(tables, lambda_context, {'tags': ['x']})
    assert status == 500
