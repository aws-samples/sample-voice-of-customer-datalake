"""``shared.dynamo_paging``: every item across pages, at most ``max_items``, lazily.

Run on moto with a page ``Limit`` small enough that the walk spans several pages,
so the ``ExclusiveStartKey`` chaining is the real DynamoDB one.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, call

import pytest
from boto3.dynamodb.conditions import Attr, Key
from moto import mock_aws

from shared.dynamo_paging import count_query, iter_query, query_all
from shared.test.moto_tables import create_pk_sk_table

ROWS = 23


@pytest.fixture
def table() -> Any:
    with mock_aws():
        created = create_pk_sk_table('paging-test')
        with created.batch_writer() as batch:
            for n in range(ROWS):
                batch.put_item(Item={'pk': 'P', 'sk': f'S{n:03d}', 'n': n})
            batch.put_item(Item={'pk': 'OTHER', 'sk': 'S000', 'n': -1})
        yield created


def _kwargs() -> dict[str, Any]:
    return {'KeyConditionExpression': Key('pk').eq('P'), 'Limit': 5}


class TestOnMoto:
    def test_every_item_of_the_partition_is_read_across_pages_in_key_order(self, table):
        assert [int(row['n']) for row in iter_query(table, _kwargs())] == list(range(ROWS))

    def test_max_items_cuts_the_walk_exactly(self, table):
        assert [int(row['n']) for row in query_all(table, _kwargs(), max_items=7)] == list(range(7))

    @pytest.mark.parametrize('max_items', [0, -3])
    def test_a_non_positive_max_items_reads_nothing(self, table, max_items):
        assert query_all(table, _kwargs(), max_items=max_items) == []

    def test_a_max_items_above_the_total_returns_everything(self, table):
        assert len(query_all(table, _kwargs(), max_items=ROWS + 10)) == ROWS

    def test_the_callers_kwargs_are_not_mutated(self, table):
        kwargs = _kwargs()
        before = dict(kwargs)
        query_all(table, kwargs)
        assert kwargs == before
        assert 'ExclusiveStartKey' not in kwargs

    def test_count_query_counts_every_match_across_pages_after_the_filter(self, table):
        assert count_query(table, _kwargs()) == ROWS
        filtered = {**_kwargs(), 'FilterExpression': Attr('n').lt(10)}
        assert count_query(table, filtered) == 10
        assert 'Select' not in filtered


class TestRequests:
    def test_each_page_starts_at_the_previous_pages_last_evaluated_key(self):
        stub = MagicMock()
        stub.query.side_effect = [
            {'Items': [{'sk': 'A'}], 'LastEvaluatedKey': {'pk': 'p', 'sk': 'A'}},
            {'Items': [{'sk': 'B'}], 'LastEvaluatedKey': {'pk': 'p', 'sk': 'B'}},
            {'Items': [{'sk': 'C'}]},
        ]
        assert query_all(stub, {'k': 'v'}) == [{'sk': 'A'}, {'sk': 'B'}, {'sk': 'C'}]
        assert stub.query.call_args_list == [
            call(k='v'),
            call(k='v', ExclusiveStartKey={'pk': 'p', 'sk': 'A'}),
            call(k='v', ExclusiveStartKey={'pk': 'p', 'sk': 'B'}),
        ]

    def test_reaching_max_items_reads_no_further_page(self):
        stub = MagicMock()
        stub.query.side_effect = [{'Items': [{'sk': 'A'}, {'sk': 'B'}], 'LastEvaluatedKey': {'pk': 'p'}}]
        assert query_all(stub, {}, max_items=2) == [{'sk': 'A'}, {'sk': 'B'}]
        stub.query.assert_called_once_with()

    def test_nothing_is_read_until_the_iterator_is_consumed(self):
        stub = MagicMock()
        iterator = iter_query(stub, {})
        stub.query.assert_not_called()
        stub.query.return_value = {'Items': [{'sk': 'A'}]}
        assert list(iterator) == [{'sk': 'A'}]

    @pytest.mark.parametrize('page', [None, 'junk', {}, {'Items': 'junk'}, {'Items': [{'sk': 'A'}], 'LastEvaluatedKey': 'x'},
                                      {'Items': [{'sk': 'A'}], 'LastEvaluatedKey': {}}])
    def test_a_malformed_page_or_cursor_ends_the_walk(self, page):
        stub = MagicMock()
        stub.query.side_effect = [page]
        rows = query_all(stub, {})
        assert rows == ([{'sk': 'A'}] if isinstance(page, dict) and isinstance(page.get('Items'), list) else [])
        stub.query.assert_called_once_with()

    def test_non_dict_items_are_skipped_and_do_not_count_towards_max_items(self):
        stub = MagicMock()
        stub.query.side_effect = [{'Items': ['junk', {'sk': 'A'}, 3, {'sk': 'B'}, {'sk': 'C'}]}]
        assert query_all(stub, {}, max_items=2) == [{'sk': 'A'}, {'sk': 'B'}]

    def test_count_query_sums_counts_selects_count_and_stops_on_a_malformed_page(self):
        stub = MagicMock()
        stub.query.side_effect = [{'Count': 4, 'LastEvaluatedKey': {'pk': 'p'}}, {'Count': 'x',
                                  'LastEvaluatedKey': {'pk': 'q'}}, {'Count': 2}]
        assert count_query(stub, {'k': 'v'}) == 6
        assert stub.query.call_args_list == [
            call(k='v', Select='COUNT'),
            call(k='v', Select='COUNT', ExclusiveStartKey={'pk': 'p'}),
            call(k='v', Select='COUNT', ExclusiveStartKey={'pk': 'q'}),
        ]
        stub.query.side_effect = [None]
        assert count_query(stub, {}) == 0
