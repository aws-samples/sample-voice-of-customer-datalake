"""The multi-value list facets of ItemFilters: source, category, subcategory, sentiment, usefulness.

Ported from PR #429 (@aws-bryan): one value means what it always meant, a comma list
means any of its values, and a malformed list is refused.
"""
import pytest
from boto3.dynamodb.conditions import Attr

from shared.item_facets import MAX_FACET_VALUE_CHARS, MAX_FACET_VALUES
from shared.item_filters import ItemFilters, parse_item_filters

WEB = {'source_platform': 'web', 'category': 'delivery', 'subcategory': 'late', 'sentiment_label': 'negative',
       'usefulness': 'high'}
APP = {'source_platform': 'app', 'category': 'billing', 'subcategory': 'refund', 'sentiment_label': 'positive',
       'usefulness': 'low'}
UNSCORED = {'source_platform': 'email', 'sentiment_label': 'neutral'}
ITEMS = [WEB, APP, UNSCORED]


def _kept(params: dict) -> list[dict]:
    return parse_item_filters(params).filter(ITEMS)


@pytest.mark.parametrize(('params', 'expected'), [
    ({'source': 'web'}, [WEB]),
    ({'category': 'billing'}, [APP]),
    ({'subcategory': 'late'}, [WEB]),
    ({'sentiment': 'neutral'}, [UNSCORED]),
    ({'usefulness': 'low'}, [APP]),
])
def test_one_value_keeps_exactly_its_items(params, expected):
    assert _kept(params) == expected


@pytest.mark.parametrize(('params', 'expected'), [
    ({'source': 'web,app'}, [WEB, APP]),
    ({'source': ' web , email '}, [WEB, UNSCORED]),
    ({'category': 'delivery,billing'}, [WEB, APP]),
    ({'sentiment': 'negative,positive'}, [WEB, APP]),
    ({'usefulness': 'high,low'}, [WEB, APP]),
])
def test_a_list_keeps_the_union_of_its_values(params, expected):
    assert _kept(params) == expected


def test_facets_combine_with_and():
    assert _kept({'source': 'web,app', 'sentiment': 'positive'}) == [APP]


def test_an_unscored_review_matches_only_the_explicit_unrated_value():
    assert _kept({'usefulness': 'low,medium,high'}) == [WEB, APP]
    assert _kept({'usefulness': 'unrated'}) == [UNSCORED]
    assert _kept({'usefulness': 'unrated,high'}) == [WEB, UNSCORED]
    assert ItemFilters(usefulness=('unrated',)).admits({'usefulness': 'bogus'})


def test_other_matches_every_unconfigured_category_once_the_configuration_is_bound():
    legacy = {'category': 'pricing'}
    filters = parse_item_filters({'category': 'other'})
    assert not filters.admits(legacy)
    assert filters.with_configured(['delivery', 'billing']).admits(legacy)
    assert not filters.with_configured(['delivery', 'billing']).admits(WEB)


@pytest.mark.parametrize('params', [
    {'sentiment': 'angry'},
    {'sentiment': 'negative,angry'},
    {'usefulness': 'great'},
    {'source': ','.join(f's{n}' for n in range(MAX_FACET_VALUES + 1))},
    {'category': 'x' * (MAX_FACET_VALUE_CHARS + 1)},
])
def test_a_malformed_list_is_refused(params):
    with pytest.raises(ValueError, match=r'must be|at most'):
        parse_item_filters(params)


def test_blank_parts_and_duplicates_are_dropped_and_non_strings_ignored():
    filters = parse_item_filters({'source': 'web,,web, ', 'category': ['x'], 'sentiment': ''})
    assert filters == ItemFilters(sources=('web',))


def test_the_sources_push_down_as_eq_for_one_and_in_for_several():
    assert parse_item_filters({'source': 'web'}).source_condition() == Attr('source_platform').eq('web')
    assert parse_item_filters({'source': 'web,app'}).source_condition() == \
        Attr('source_platform').is_in(['web', 'app'])
    assert ItemFilters().source_condition() is None


def test_the_other_facets_push_down_in_the_row_condition():
    condition = parse_item_filters({'sentiment': 'negative,mixed'}).row_condition()
    assert condition == Attr('sentiment_label').is_in(['negative', 'mixed'])
    assert parse_item_filters({'category': 'delivery'}).row_condition() == Attr('category').eq('delivery')
    # `other` without the configuration cannot be expressed: left to the in-memory filter.
    assert parse_item_filters({'category': 'other'}).row_condition() is None


def test_usefulness_unrated_pushes_down_as_no_stored_band():
    condition = parse_item_filters({'usefulness': 'unrated'}).row_condition()
    assert condition == Attr('usefulness').not_exists() | ~Attr('usefulness').is_in(['low', 'medium', 'high'])


def test_a_usefulness_filter_cannot_use_the_channel_index():
    assert not parse_item_filters({'usefulness': 'high'}).channel_index_serves
    assert parse_item_filters({'source': 'web'}).channel_index_serves
