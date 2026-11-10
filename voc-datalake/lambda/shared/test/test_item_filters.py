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

    def test_the_date_query_applies_them(self, monkeypatch):
        from unittest.mock import MagicMock

        from shared.feedback import query_feedback_by_date
        from shared.test.feedback_doubles import fetch_rows_as_read

        fetch_rows_as_read(monkeypatch)

        table = MagicMock()
        table.query.return_value = {'Items': [ITEM, {**ITEM, 'tags': []}]}
        items = query_feedback_by_date(table, days=1, item_filters=ItemFilters(tag='vip'))
        assert items == [ITEM]


# Star-rating bounds: the Categories "4+ stars" / "3 and below" picker, applied
# server-side so pagination and totals count only matching items.
@pytest.mark.parametrize(('params', 'rating', 'admitted'), [
    ({'rating_min': '4'}, 4, True),
    ({'rating_min': '4'}, 5, True),
    ({'rating_min': '4'}, 3, False),
    ({'rating_max': '3'}, 3, True),
    ({'rating_max': '3'}, 4, False),
    ({'rating_min': '2', 'rating_max': '3'}, '2.5', True),
    ({'rating_min': '4'}, None, False),
    ({'rating_max': '3'}, 0, False),
    ({'rating_max': '3'}, 'n/a', False),
    ({'rating_max': '3'}, True, False),
])
def test_rating_bounds_are_inclusive_and_refuse_unrated_items(params, rating, admitted):
    filters = parse_item_filters(params)
    assert filters.active
    assert filters.admits({'rating': rating}) is admitted


@pytest.mark.parametrize('value', ['0', '6', '4.5', 'four', '-1'])
def test_a_malformed_rating_bound_is_refused(value):
    with pytest.raises(ValueError, match='rating_min'):
        parse_item_filters({'rating_min': value})


def test_a_blank_rating_bound_is_ignored():
    assert parse_item_filters({'rating_min': ' ', 'rating_max': ''}) == ItemFilters()


def test_only_the_channel_becomes_a_row_condition():
    """dims and tag match ignoring case, which a DynamoDB FilterExpression cannot; the channel is exact."""
    condition = parse_item_filters({'channel': ' google_play ', 'tag': 'VIP'}).row_condition()
    assert condition is not None
    expression = condition.get_expression()
    assert (expression['format'], expression['values'][0].name, expression['values'][1]) == (
        '{0} {operator} {1}', 'source_channel', 'google_play')


@pytest.mark.parametrize('params', [None, {}, {'tag': 'vip'}, {'dims': 'product:app'}, {'rating_min': '3'}])
def test_no_channel_means_no_row_condition(params):
    assert parse_item_filters(params).row_condition() is None


@pytest.mark.parametrize(('value', 'on'), [('1', True), ('true', True), (' TRUE ', True), ('0', False), ('', False), ('yes', False)])
def test_urgent_only_is_switched_on_by_one_or_true(value, on):
    assert parse_item_filters({'urgent': value}).urgent is on


def test_urgent_only_admits_high_urgency_items_and_forces_the_item_path():
    filters = parse_item_filters({'urgent': '1'})
    assert filters.active
    assert filters.filter([{'urgency': 'high'}, {'urgency': 'low'}, {}]) == [{'urgency': 'high'}]


def test_urgent_only_is_pushed_down_beside_the_channel():
    condition = parse_item_filters({'channel': 'email', 'urgent': '1'}).row_condition()
    assert condition is not None
    expression = condition.get_expression()
    assert expression['operator'] == 'AND'
    names = {value.get_expression()['values'][0].name for value in expression['values']}
    assert names == {'source_channel', 'urgency'}
