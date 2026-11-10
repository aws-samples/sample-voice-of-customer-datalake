"""`shared.category_scope_query`: the pushed-down scope admits exactly what `admits_item` admits."""
from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from shared.category_access import UNRESTRICTED, CategoryScope, admits_item
from shared.category_scope_query import MAX_IN_OPERANDS, admits_nothing, combine, scope_filter

ROWS = [
    {'pk': 'a', 'category': 'delivery', 'source_platform': 'web'},
    {'pk': 'b', 'category': 'billing', 'source_platform': 'app'},
    {'pk': 'c', 'source_platform': 'web'},                       # uncategorised -> 'other'
    {'pk': 'd', 'category': '', 'source_platform': 'tickets'},   # empty -> 'other'
    {'pk': 'e', 'category': 'delivery'},                         # no source
]


@pytest.fixture
def table():
    with mock_aws():
        created = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='scope-query', KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}],
            AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'}], BillingMode='PAY_PER_REQUEST')
        for row in ROWS:
            created.put_item(Item=row)
        yield created


def _admitted(table, scope: CategoryScope) -> set[str]:
    condition = scope_filter(scope)
    kwargs = {'FilterExpression': condition} if condition is not None else {}
    return {row['pk'] for row in table.scan(**kwargs)['Items']}


@pytest.mark.parametrize('scope', [
    CategoryScope(all=False, categories=frozenset({'delivery'})),
    CategoryScope(all=False, categories=frozenset({'other'})),
    CategoryScope(all=True, source_allow=frozenset({'web'})),
    CategoryScope(all=True, source_deny=frozenset({'tickets'})),
    CategoryScope(all=False, categories=frozenset({'delivery', 'other'}), source_deny=frozenset({'web'})),
])
def test_pushed_down_scope_matches_the_policy(table, scope):
    assert _admitted(table, scope) == {row['pk'] for row in ROWS if admits_item(scope, row)}


def test_unrestricted_and_oversized_scopes_push_nothing():
    assert scope_filter(UNRESTRICTED) is None
    assert scope_filter(None) is None
    many = frozenset(f'c{n}' for n in range(MAX_IN_OPERANDS))
    assert scope_filter(CategoryScope(all=False, categories=many)) is None


def test_admits_nothing():
    assert admits_nothing(CategoryScope(all=False))
    assert admits_nothing(CategoryScope(all=True, source_allow=frozenset()))
    assert not admits_nothing(CategoryScope(all=False, categories=frozenset({'delivery'})))
    assert not admits_nothing(UNRESTRICTED)


def test_combine_skips_none():
    assert combine(None, None) is None
