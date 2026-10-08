"""The strict-Query guard (shared/test/strict_dynamodb.py) and the memory reads it protects.

Production answered 502 on ``GET /memory?scope=personal`` and ``GET /memory/review``:
``ValidationException: Filter Expression can only contain non-primary key attributes:
Primary key attribute: sk``. moto accepted the request, so these tests pin both the
guard (it must refuse what DynamoDB refuses) and the query shapes memory_store sends.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest
from boto3.dynamodb.conditions import Attr, ConditionExpressionBuilder, Key
from botocore.exceptions import ClientError
from moto import mock_aws
from moto.dynamodb.exceptions import MockValidationException

from api.test.moto_helpers import pk_sk_table
from shared import memory_store
from shared.indexes import MEMORY_BY_STATUS_INDEX
from shared.test.strict_dynamodb import check_expression_maps, check_query, filter_attribute_names

BASE_SCHEMA = [{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}]
GSI_SCHEMA = [{'AttributeName': 'gsi1pk', 'KeyType': 'HASH'}, {'AttributeName': 'gsi1sk', 'KeyType': 'RANGE'}]


# ── The parser ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize(('expression', 'names', 'expected'), [
    ('begins_with(#n0, :v0) AND #n1 = :v1', {'#n0': 'sk', '#n1': 'status'}, {'sk', 'status'}),
    ('begins_with(sk, :p)', {}, {'sk'}),
    ('attribute_exists(pk) OR NOT contains(search_text, :q)', {}, {'pk', 'search_text'}),
    ('size(tags) > :n AND meta.sk = :x', {}, {'tags', 'meta'}),
    ('#a BETWEEN :lo AND :hi', {'#a': 'count'}, {'count'}),
    ('kind IN (:a, :b)', {}, {'kind'}),
])
def test_filter_attribute_names(expression: str, names: dict[str, str], expected: set[str]) -> None:
    assert filter_attribute_names(expression, names) == expected


# ── The rule ─────────────────────────────────────────────────────────────────
def _wire(condition) -> dict[str, Any]:
    built = ConditionExpressionBuilder().build_expression(condition)
    return {'FilterExpression': built.condition_expression, 'ExpressionAttributeNames': built.attribute_name_placeholders}


@pytest.mark.parametrize('key', ['pk', 'sk'])
def test_a_base_table_key_in_the_filter_is_refused(key: str) -> None:
    with pytest.raises(MockValidationException, match=f'Primary key attribute: {key}'):
        check_query(_wire(Attr(key).begins_with('MEM#') & Attr('status').eq('active')), BASE_SCHEMA)


def test_an_index_key_in_an_index_query_filter_is_refused() -> None:
    with pytest.raises(MockValidationException, match='Primary key attribute: gsi1sk'):
        check_query(_wire(Attr('gsi1sk').gt('2026')), GSI_SCHEMA)


def _refused(body: dict[str, Any], schema: list[dict[str, str]]) -> bool:
    try:
        check_query(body, schema)
    except MockValidationException:
        return True
    return False


def test_non_key_filters_and_base_keys_on_an_index_query_pass() -> None:
    assert not _refused(_wire(Attr('status').eq('active') & Attr('kind').eq('product')), BASE_SCHEMA)
    assert not _refused(_wire(Attr('sk').begins_with('MEM#')), GSI_SCHEMA)  # base sk is not a key OF the index
    assert not _refused({}, BASE_SCHEMA)
    assert _refused(_wire(Attr('sk').begins_with('MEM#')), BASE_SCHEMA)


def test_moto_now_answers_what_dynamodb_answers() -> None:
    """End to end through boto3 + moto, the exact production error comes back."""
    with mock_aws():
        table = pk_sk_table('strict-guard', gsi1_index=MEMORY_BY_STATUS_INDEX)
        with pytest.raises(ClientError) as raised:
            table.query(KeyConditionExpression=Key('pk').eq('MEM#company'),
                        FilterExpression=Attr('sk').begins_with('MEM#'))
        error = raised.value.response.get('Error', {})
        assert error.get('Code') == 'ValidationException'
        assert 'Primary key attribute: sk' in error.get('Message', '')
        assert table.query(KeyConditionExpression=Key('pk').eq('MEM#company') & Key('sk').begins_with('MEM#'),
                           FilterExpression=Attr('status').eq('active'))['Items'] == []


def test_an_empty_expression_attribute_names_map_is_refused_like_dynamodb() -> None:
    """E2E s2 F3: ``ExpressionAttributeNames={}`` on UpdateItem (agent Run now) -> 500 in production."""
    with mock_aws():
        table = pk_sk_table('strict-maps')
        table.put_item(Item={'pk': 'a', 'sk': 'b'})
        with pytest.raises(ClientError) as raised:
            table.update_item(Key={'pk': 'a', 'sk': 'b'}, UpdateExpression='ADD n :one',
                              ExpressionAttributeNames={}, ExpressionAttributeValues={':one': 1})
        error = raised.value.response.get('Error', {})
        assert error.get('Code') == 'ValidationException'
        assert error.get('Message') == 'ExpressionAttributeNames must not be empty'
        # Omitting the map is fine, as in DynamoDB.
        table.update_item(Key={'pk': 'a', 'sk': 'b'}, UpdateExpression='ADD n :one', ExpressionAttributeValues={':one': 1})
        with pytest.raises(MockValidationException, match='ExpressionAttributeValues must not be empty'):
            check_expression_maps({'TransactItems': [{'Update': {'ExpressionAttributeValues': {}}}]})


# ── The memory_store query shapes (recording stub, no moto) ─────────────────
def _recording_table() -> MagicMock:
    table = MagicMock()
    table.query.return_value = {'Items': []}
    return table


def _assert_valid_queries(table: MagicMock) -> list[dict[str, Any]]:
    """Render every recorded Query and apply DynamoDB's rule to it; return the kwargs."""
    calls = [c.kwargs for c in table.query.call_args_list]
    assert calls, 'expected at least one Query'
    for kwargs in calls:
        schema = GSI_SCHEMA if kwargs.get('IndexName') else BASE_SCHEMA
        condition = kwargs.get('FilterExpression')
        if condition is not None:
            check_query(_wire(condition), schema)
    return calls


def _key_names(kwargs: dict[str, Any]) -> set[str]:
    built = ConditionExpressionBuilder().build_expression(kwargs['KeyConditionExpression'], is_key_condition=True)
    return set(built.attribute_name_placeholders.values())


def test_list_personal_keeps_the_sk_prefix_in_the_key_condition() -> None:
    table = _recording_table()
    memory_store.list_personal(table, 'sub-1', 'active', kind='product', q='checkout')
    [kwargs] = _assert_valid_queries(table)
    assert _key_names(kwargs) == {'pk', 'sk'}


def test_load_pool_keeps_the_sk_prefix_in_the_key_condition() -> None:
    table = _recording_table()
    memory_store.load_pool(table, memory_store.COMPANY_PK)
    [kwargs] = _assert_valid_queries(table)
    assert _key_names(kwargs) == {'pk', 'sk'}
    assert 'FilterExpression' not in kwargs


def test_every_memory_read_sends_a_valid_query(monkeypatch: pytest.MonkeyPatch) -> None:
    """list_company / query_status / count_status / query_partition / retrieve / related_live."""
    monkeypatch.setattr(memory_store, 'embed_text', lambda _text: [0.0] * 4)
    table = _recording_table()
    memory_store.list_company(table, 'active', kind='product', q='late', limit=10, start_key=None)
    memory_store.query_status(table, 'company', 'proposed', attributes=memory_store.LIST_ATTRIBUTES)
    memory_store.count_status(table, 'company', 'conflict')
    memory_store.query_partition(table, memory_store.IMPORT_PK)
    memory_store.clear_pool_cache()
    memory_store.retrieve(table, 'checkout', caller_sub='sub-1', include_personal=True, k=3)
    memory_store.clear_pool_cache()
    memory_store.related_live(table, 'checkout', caller_sub='sub-1')
    memory_store.clear_pool_cache()
    calls = _assert_valid_queries(table)
    assert len(calls) == 8  # retrieve and related_live each read company + personal
