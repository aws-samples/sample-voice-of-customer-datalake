"""Tests for shared/feedback_filters.py — the shared feedback filter model."""
import pytest

from shared.enrichment_fields import UNSCORED
from shared.exceptions import ValidationError
from shared.feedback_filters import (
    MAX_CUSTOM_FIELD_FILTERS,
    MAX_FILTER_VALUE_LENGTH,
    MAX_FILTER_VALUES,
    FeedbackFilters,
    item_matches_custom_fields,
    parse_custom_field_filters,
)

ITEM = {
    'source_platform': 'webscraper',
    'category': 'delivery',
    'subcategory': 'late',
    'sentiment_label': 'negative',
    'urgency': 'high',
    'usefulness': 'high',
    'custom_fields': {'region': 'EMEA', 'tier': 5},
}


class TestParsing:
    def test_empty_input_is_an_empty_filter(self):
        assert FeedbackFilters.from_mapping(None).is_empty
        assert FeedbackFilters.from_mapping({}).is_empty
        assert FeedbackFilters.from_mapping({'days': '7', 'limit': '50'}).is_empty

    def test_comma_separated_query_params_become_ordered_unique_lists(self):
        f = FeedbackFilters.from_mapping({
            'source': 'a, b,,a', 'category': 'delivery', 'sentiment': 'negative,mixed',
        })
        assert f.sources == ('a', 'b')
        assert f.categories == ('delivery',)
        assert f.sentiments == ('negative', 'mixed')

    def test_json_body_lists_are_accepted(self):
        f = FeedbackFilters.from_mapping({'source': ['a', 'b'], 'usefulness': ['high', 'UNSCORED']})
        assert f.sources == ('a', 'b')
        assert f.enrichment_values('usefulness') == ('high', UNSCORED)

    @pytest.mark.parametrize('raw,expected', [
        ('true', True), ('1', True), ('YES', True), (True, True),
        ('false', False), ('', False), (None, False), ('0', False),
    ])
    def test_urgent_flag(self, raw, expected):
        assert FeedbackFilters.from_mapping({'urgent': raw}).urgent_only is expected

    def test_unknown_enrichment_value_is_a_validation_error(self):
        with pytest.raises(ValidationError):
            FeedbackFilters.from_mapping({'usefulness': 'extreme'})

    def test_too_many_values_is_a_validation_error(self):
        many = ','.join(f's{i}' for i in range(MAX_FILTER_VALUES + 1))
        with pytest.raises(ValidationError):
            FeedbackFilters.from_mapping({'source': many})

    def test_overlong_value_is_a_validation_error(self):
        with pytest.raises(ValidationError):
            FeedbackFilters.from_mapping({'category': 'x' * (MAX_FILTER_VALUE_LENGTH + 1)})

    def test_custom_fields_from_cf_params_or_a_body_map(self):
        from_params = FeedbackFilters.from_mapping({'cf_region': 'EMEA', 'cf_plan': ''})
        from_body = FeedbackFilters.from_mapping({'custom_fields': {'region': 'EMEA'}})
        assert from_params.custom_field_map == {'region': ('EMEA',)}
        assert from_params == from_body

    def test_a_repeated_cf_param_is_read_from_the_multi_value_view(self):
        # API Gateway puts only the LAST repeated value in the single-value view.
        f = FeedbackFilters.from_mapping(
            {'cf_tier': 'Platinum', 'cf_region': 'EMEA'},
            {'cf_tier': ['Gold', 'Platinum', 'Gold'], 'cf_region': ['EMEA']},
        )
        assert f.custom_field_map == {'region': ('EMEA',), 'tier': ('Gold', 'Platinum')}

    def test_custom_values_are_never_comma_split_or_trimmed(self):
        # The match is exact against str(stored), so commas and spaces are data.
        f = FeedbackFilters.from_mapping({'cf_city': 'Las Vegas, NV'}, {'cf_city': ['Las Vegas, NV', 'Reno ']})
        assert f.custom_field_map == {'city': ('Las Vegas, NV', 'Reno ')}

    def test_a_body_map_accepts_a_list_of_values(self):
        f = FeedbackFilters.from_mapping({'custom_fields': {'tier': ['Gold', 'Platinum'], 'region': 'EMEA'}})
        assert f.custom_field_map == {'region': ('EMEA',), 'tier': ('Gold', 'Platinum')}

    def test_too_many_values_for_one_custom_field_is_a_validation_error(self):
        with pytest.raises(ValidationError):
            FeedbackFilters.from_mapping({'cf_tier': 'x'}, {'cf_tier': [f'v{i}' for i in range(MAX_FILTER_VALUES + 1)]})

    def test_overlong_custom_value_is_a_validation_error(self):
        with pytest.raises(ValidationError):
            FeedbackFilters.from_mapping({'cf_tier': 'x' * (MAX_FILTER_VALUE_LENGTH + 1)})

    def test_instances_are_hashable(self):
        f = FeedbackFilters.from_mapping({'source': 'a', 'cf_region': 'EMEA', 'usefulness': 'high'})
        assert hash(f) == hash(FeedbackFilters.from_mapping({'cf_region': 'EMEA', 'source': 'a', 'usefulness': 'high'}))


class TestMatches:
    def test_empty_filter_matches_everything(self):
        assert FeedbackFilters().matches(ITEM)
        assert FeedbackFilters().matches({})

    @pytest.mark.parametrize('params', [
        {'source': 'webscraper,other'},
        {'category': 'delivery'},
        {'subcategory': 'late'},
        {'sentiment': 'negative,mixed'},
        {'urgent': 'true'},
        {'usefulness': 'high'},
        {'cf_region': 'EMEA', 'cf_tier': '5'},
        {'source': 'webscraper', 'category': 'delivery', 'usefulness': 'high,medium', 'urgent': 'true'},
    ])
    def test_matching_item_passes(self, params):
        assert FeedbackFilters.from_mapping(params).matches(ITEM)

    @pytest.mark.parametrize('params', [
        {'source': 'other'},
        {'category': 'pricing'},
        {'subcategory': 'early'},
        {'sentiment': 'positive'},
        {'usefulness': 'low'},
        {'cf_region': 'APAC'},
        {'source': 'webscraper', 'category': 'pricing'},  # AND across dimensions
    ])
    def test_non_matching_item_fails(self, params):
        assert not FeedbackFilters.from_mapping(params).matches(ITEM)

    def test_several_values_of_one_custom_field_match_any_of_them(self):
        f = FeedbackFilters.from_mapping({'cf_region': 'APAC'}, {'cf_region': ['APAC', 'EMEA']})
        assert f.matches(ITEM)
        assert not f.matches({**ITEM, 'custom_fields': {'region': 'LATAM', 'tier': 5}})

    def test_custom_fields_still_and_across_keys(self):
        f = FeedbackFilters.from_mapping(
            {'cf_region': 'EMEA', 'cf_tier': '7'}, {'cf_region': ['EMEA', 'APAC'], 'cf_tier': ['6', '7']},
        )
        assert not f.matches(ITEM)  # region matches, tier 5 does not

    def test_urgent_only_rejects_non_urgent(self):
        assert not FeedbackFilters(urgent_only=True).matches({**ITEM, 'urgency': 'medium'})

    def test_unscored_matches_items_without_a_value(self):
        f = FeedbackFilters.from_mapping({'usefulness': UNSCORED})
        assert f.matches({'source_platform': 'x'})
        assert f.matches({'usefulness': 'garbage'})
        assert not f.matches(ITEM)


class TestDerived:
    def test_has_post_filters_ignores_sources(self):
        assert not FeedbackFilters(sources=('a',)).has_post_filters
        assert FeedbackFilters(sentiments=('negative',)).has_post_filters
        assert FeedbackFilters(custom_fields=(('region', ('EMEA',)),)).has_post_filters

    def test_without_sources_keeps_everything_else(self):
        f = FeedbackFilters.from_mapping({'source': 'a', 'category': 'c', 'cf_region': 'EMEA', 'urgent': '1'})
        stripped = f.without_sources()
        assert stripped.sources == ()
        assert stripped.categories == ('c',)
        assert stripped.custom_field_map == {'region': ('EMEA',)}
        assert stripped.urgent_only

    def test_to_dict_round_trips_and_omits_inactive_dimensions(self):
        params = {
            'source': 'a,b', 'sentiment': 'negative', 'urgent': 'true',
            'usefulness': 'high,unscored', 'cf_region': 'EMEA', 'cf_tier': 'Platinum',
        }
        f = FeedbackFilters.from_mapping(params, {'cf_tier': ['Gold', 'Platinum']})
        as_dict = f.to_dict()
        assert as_dict == {
            'source': ['a', 'b'], 'sentiment': ['negative'], 'urgent': True,
            'usefulness': ['high', 'unscored'],
            'custom_fields': {'region': ['EMEA'], 'tier': ['Gold', 'Platinum']},
        }
        assert FeedbackFilters.from_mapping(as_dict) == f
        assert FeedbackFilters().to_dict() == {}

    def test_attribute_paths_name_exactly_what_matches_reads(self):
        f = FeedbackFilters.from_mapping({
            'source': 'a', 'subcategory': 's', 'urgent': 'true',
            'usefulness': 'high', 'cf_region': 'EMEA', 'cf_tier': 'Gold',
        })
        assert set(f.attribute_paths()) == {
            ('source_platform',), ('subcategory',), ('urgency',), ('usefulness',),
            ('custom_fields', 'region'), ('custom_fields', 'tier'),
        }
        assert FeedbackFilters().attribute_paths() == ()

    def test_a_row_projected_to_attribute_paths_matches_like_the_full_row(self):
        """The contract the persona pool's projection relies on."""
        f = FeedbackFilters.from_mapping({'urgent': 'true', 'cf_tier': 'Gold'})
        full = {
            'urgency': 'high', 'original_text': 'long text',
            'custom_fields': {'tier': 'Gold', 'region': 'EMEA'},
        }
        projected = {'urgency': 'high', 'custom_fields': {'tier': 'Gold'}}
        assert f.matches(full) is f.matches(projected) is True


class TestCustomFieldHelpers:
    def test_parse_ignores_empty_values_and_bare_prefix(self):
        parsed = parse_custom_field_filters({'cf_': 'x', 'cf_a': '', 'cf_b': None, 'cf_c': 'v', 'days': '7'})
        assert parsed == {'c': ('v',)}

    def test_parse_drops_empty_entries_from_a_repeated_param(self):
        assert parse_custom_field_filters({'cf_t': 'a'}, {'cf_t': ['', 'a', '']}) == {'t': ('a',)}

    def test_parse_bounds_the_number_of_filters(self):
        with pytest.raises(ValidationError):
            parse_custom_field_filters({f'cf_k{i}': 'v' for i in range(MAX_CUSTOM_FIELD_FILTERS + 1)})

    def test_match_coalesces_numbers_and_fails_on_missing(self):
        assert item_matches_custom_fields({'custom_fields': {'tier': 5}}, {'tier': ('5',)})
        assert not item_matches_custom_fields({'custom_fields': {}}, {'tier': ('5',)})
        assert not item_matches_custom_fields({}, {'tier': ('5',)})
        assert item_matches_custom_fields({}, {})

    def test_match_treats_a_bare_string_as_one_value_not_a_substring(self):
        assert item_matches_custom_fields({'custom_fields': {'tier': 'Gold'}}, {'tier': 'Gold'})
        assert not item_matches_custom_fields({'custom_fields': {'tier': 'old'}}, {'tier': 'Gold'})
