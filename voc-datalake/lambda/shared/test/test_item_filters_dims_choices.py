"""`dims=key:a|b` (either value) and the `~unset` choice in `shared.item_filters`.

The Problems page's "Problems only" type filter sends
``dims=feedback_type:bug|service_failure|...|~unset``: several values of one key
(OR within the key), plus reviews not typed yet. Pairs across keys still AND, and a
configured value that itself contains ``|`` still matches exactly.
"""
from __future__ import annotations

from typing import Any

import pytest

from shared.dimension_config import parse_dims_param
from shared.item_filters import DIMS_UNSET_VALUE, ItemFilters, dimension_choices, parse_item_filters


def _typed(value: Any = None, **other: Any) -> dict[str, Any]:
    """A review whose `dimensions` map holds `feedback_type=value` (omitted when None) and `other`."""
    dims = {**({'feedback_type': value} if value is not None else {}), **other}
    return {'feedback_id': 'x', 'dimensions': dims}


def _admits(dims: str, item: dict[str, Any]) -> bool:
    return parse_item_filters({'dims': dims}).admits(item)


# ---------------------------------------------------------------- parsing


class TestParsing:
    def test_a_multi_value_pair_parses_as_one_value(self):
        assert parse_dims_param('feedback_type:bug|service_failure') == {'feedback_type': 'bug|service_failure'}

    def test_the_unset_choice_passes_validation_alone_and_in_a_list(self):
        assert parse_dims_param('feedback_type:~unset') == {'feedback_type': '~unset'}
        assert parse_dims_param('feedback_type:bug|~unset,region:emea') == {
            'feedback_type': 'bug|~unset', 'region': 'emea'}

    def test_the_problems_page_default_set_is_accepted(self):
        # The SPA's real "Problems only" value (frontend/src/pages/ProblemAnalysis/feedbackTypes.ts,
        # 83 characters): each choice is a dimension value, the list may be longer than one.
        default = 'bug|service_failure|performance|usability|pricing_billing|support_experience|~unset'
        assert len(default) > 64
        assert parse_dims_param(f'feedback_type:{default}') == {'feedback_type': default}

    def test_a_choice_longer_than_64_characters_is_refused(self):
        with pytest.raises(ValueError, match='key:value'):
            parse_dims_param(f'feedback_type:bug|{"x" * 65}')

    @pytest.mark.parametrize('value', ['bug|a b', 'bug|#x'])
    def test_a_list_with_a_malformed_choice_is_refused(self, value):
        with pytest.raises(ValueError, match='key:value'):
            parse_dims_param(f'feedback_type:{value}')

    @pytest.mark.parametrize('value', ['|', '||', 'bug|'])
    def test_a_bare_separator_stays_one_well_formed_value(self, value):
        # `|` is allowed inside a dimension value, so these parse as before multi-value pairs.
        assert parse_dims_param(f'feedback_type:{value}') == {'feedback_type': value}

    def test_a_list_of_more_choices_than_a_dimension_can_hold_is_refused(self):
        with pytest.raises(ValueError, match='key:value'):
            parse_dims_param('feedback_type:' + '|'.join(f'v{i}' for i in range(202)))

    @pytest.mark.parametrize(('value', 'expected'), [
        ('bug', ('bug',)),
        ('bug|service_failure', ('bug|service_failure', 'bug', 'service_failure')),
        ('a||b', ('a||b', 'a', 'b')),
        ('bug|', ('bug|', 'bug')),
        ('|', ('|',)),
        (DIMS_UNSET_VALUE, (DIMS_UNSET_VALUE,)),
    ])
    def test_the_choices_keep_the_whole_spelling_and_each_part(self, value, expected):
        assert dimension_choices(value) == expected


# ---------------------------------------------------------------- either value


class TestEitherValue:
    @pytest.mark.parametrize('stored', ['bug', 'service_failure', 'BUG', 'Service_Failure'])
    def test_either_value_is_admitted_ignoring_case(self, stored):
        assert _admits('feedback_type:bug|service_failure', _typed(stored)) is True

    @pytest.mark.parametrize('stored', ['praise', 'bugs', 'bug|service_failure_x'])
    def test_any_other_value_is_refused(self, stored):
        assert _admits('feedback_type:bug|service_failure', _typed(stored)) is False

    def test_the_wanted_spelling_is_folded_too(self):
        assert _admits('feedback_type:BUG|Praise', _typed('praise')) is True

    def test_without_unset_a_review_with_no_type_is_refused(self):
        assert _admits('feedback_type:bug|service_failure', _typed()) is False
        assert _admits('feedback_type:bug', {'feedback_id': 'x'}) is False

    def test_a_value_containing_the_separator_still_matches_exactly(self):
        # A configured value `a|b` stored as-is: the whole spelling is one of the choices.
        filters = ItemFilters(dims={'plan': 'a|b'})
        assert filters.admits(_typed(plan='a|b')) is True
        assert filters.admits(_typed(plan='A|B')) is True
        # ...and each part is a choice as well (the OR reading).
        assert filters.admits(_typed(plan='a')) is True
        assert filters.admits(_typed(plan='c')) is False


# ---------------------------------------------------------------- ~unset


class TestUnset:
    @pytest.mark.parametrize('item', [
        {'feedback_id': 'no-map'},
        {'feedback_id': 'none-map', 'dimensions': None},
        {'feedback_id': 'not-a-map', 'dimensions': ['bug']},
        _typed(),
        _typed(''),
        {'feedback_id': 'other-key', 'dimensions': {'region': 'emea'}},
    ])
    def test_a_review_with_no_value_for_the_key_is_admitted(self, item):
        assert _admits('feedback_type:~unset', item) is True

    def test_a_typed_review_is_refused_by_unset_alone(self):
        assert _admits('feedback_type:~unset', _typed('bug')) is False

    @pytest.mark.parametrize(('item', 'expected'), [
        (_typed('bug'), True),
        (_typed(), True),
        (_typed(''), True),
        (_typed('praise'), False),
    ])
    def test_unset_combines_with_values(self, item, expected):
        assert _admits('feedback_type:bug|~unset', item) is expected

    def test_a_non_string_stored_value_counts_as_unset(self):
        assert _admits('feedback_type:~unset', _typed(3)) is True
        assert _admits('feedback_type:bug', _typed(3)) is False


# ---------------------------------------------------------------- AND across keys


class TestAcrossKeys:
    DIMS = 'feedback_type:bug|~unset,region:emea|apac'

    @pytest.mark.parametrize(('item', 'expected'), [
        (_typed('bug', region='emea'), True),
        (_typed(region='APAC'), True),
        (_typed('bug', region='amer'), False),
        (_typed('praise', region='emea'), False),
        (_typed('bug'), False),
        ({'feedback_id': 'bare'}, False),
    ])
    def test_every_key_must_admit_the_review(self, item, expected):
        assert _admits(self.DIMS, item) is expected

    def test_unset_on_both_keys_admits_a_review_without_dimensions(self):
        assert _admits('feedback_type:~unset,region:~unset', {'feedback_id': 'bare'}) is True

    def test_the_filter_keeps_order_and_drops_refused_items(self):
        items = [_typed('bug'), _typed('praise'), _typed(), _typed('service_failure')]
        kept = parse_item_filters({'dims': 'feedback_type:bug|service_failure|~unset'}).filter(items)
        assert [i['dimensions'].get('feedback_type') for i in kept] == ['bug', None, 'service_failure']
