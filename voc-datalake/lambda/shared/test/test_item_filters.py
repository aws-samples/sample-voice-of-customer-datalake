"""The channel / dims / tag post-query filters (shared/item_filters.py)."""
import pytest

from shared.item_filters import ItemFilters, parse_item_filters

ITEM = {'source_channel': 'email', 'dimensions': {'product': 'App', 'module': 'checkout'}, 'tags': ['VIP', 'beta']}


def test_no_params_is_inactive_and_admits_everything():
    filters = parse_item_filters(None)
    assert not filters.active
    items = [{}, ITEM]
    assert filters.filter(items) is items


@pytest.mark.parametrize(('params', 'admitted'), [
    ({'channel': 'email'}, True),
    ({'channel': 'chat'}, False),
    ({'dims': 'product:app'}, True),
    ({'dims': 'product:App,module:checkout'}, True),
    ({'dims': 'product:App,module:search'}, False),
    ({'tag': 'vip'}, True),
    ({'tag': 'gold'}, False),
    ({'channel': ' email ', 'tag': 'BETA', 'dims': 'module:CHECKOUT'}, True),
])
def test_every_given_filter_must_match(params, admitted):
    assert parse_item_filters(params).admits(ITEM) is admitted


@pytest.mark.parametrize('item', [{}, {'dimensions': 'x', 'tags': 'vip'}, {'dimensions': {'product': 1}, 'tags': [1]}])
def test_items_without_the_attributes_are_refused(item):
    assert not ItemFilters(dims={'product': 'App'}).admits(item)
    assert not ItemFilters(tag='vip').admits(item)


def test_blank_and_non_string_params_are_ignored():
    filters = parse_item_filters({'channel': '  ', 'tag': ['x'], 'dims': ''})
    assert filters == ItemFilters()


@pytest.mark.parametrize('dims', ['product', 'product:', 'a:b,a:c', 'Product:App'])
def test_malformed_dims_raise(dims):
    with pytest.raises(ValueError, match='dims'):
        parse_item_filters({'dims': dims})


def test_filter_keeps_order():
    other = {**ITEM, 'tags': []}
    assert ItemFilters(tag='vip').filter([ITEM, other, ITEM]) == [ITEM, ITEM]


class TestFeedbackContextFilters:
    """`shared.feedback.get_feedback_context` reads channel / dims / tag from its filters dict."""

    @pytest.mark.parametrize(('filters', 'expected'), [
        ({}, ItemFilters()),
        ({'channel': 'email', 'tag': 'vip'}, ItemFilters(channel='email', tag='vip')),
        ({'dims': 'product:App'}, ItemFilters(dims={'product': 'App'})),
        ({'dims': {'product': 'App', 'module': 'x'}}, ItemFilters(dims={'product': 'App', 'module': 'x'})),
        ({'dims': 'broken', 'tag': 'vip'}, ItemFilters(tag='vip')),
    ])
    def test_parsed_leniently(self, filters, expected):
        from shared.feedback import _context_item_filters

        assert _context_item_filters(filters) == expected

    def test_the_date_query_applies_them(self):
        from unittest.mock import MagicMock

        from shared.feedback import query_feedback_by_date

        table = MagicMock()
        table.query.return_value = {'Items': [ITEM, {**ITEM, 'tags': []}]}
        items = query_feedback_by_date(table, days=1, item_filters=ItemFilters(tag='vip'))
        assert items == [ITEM]
