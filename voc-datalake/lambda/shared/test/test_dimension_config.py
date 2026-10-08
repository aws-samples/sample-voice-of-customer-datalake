"""`shared/dimension_config.py`: the dimensions settings row, tags and the `dims` query parameter."""
from unittest.mock import MagicMock

import pytest

from shared.dimension_config import (
    DIMENSION_KEY_RE,
    DIMENSION_VALUE_RE,
    DIMENSIONS_SETTINGS_KEY,
    RESERVED_DIMENSION_KEYS,
    TAG_RE,
    allowed_values,
    load_dimensions_config,
    parse_dims_param,
    resolve_dimensions,
    validate_dimensions,
    validate_tags,
)


def _dim(key: str = 'product', **overrides: object) -> dict:
    return {'key': key, 'label': key.title(), 'values': [{'name': 'app'}, {'name': 'web'}], **overrides}


def _product_and_module() -> list[dict]:
    return validate_dimensions([
        _dim('product'),
        _dim('module', parent='product', values=[
            {'name': 'checkout', 'parent_value': 'web'},
            {'name': 'login', 'parent_value': 'app'},
            {'name': 'search'},
        ]),
    ])


def _refusal(value: object) -> str:
    with pytest.raises(ValueError, match=r'.') as exc_info:
        validate_dimensions(value)
    return str(exc_info.value)


class TestValidateDimensionsNormalises:
    def test_a_full_dimension_round_trips_trimmed_with_empty_optionals_dropped(self):
        result = validate_dimensions([{
            'key': ' product ', 'label': ' Product ', 'description': '  ', 'infer': False,
            'unknown': 'dropped',
            'values': [{'name': ' app ', 'label': ' Mobile app ', 'description': '', 'extra': 1}],
        }])
        assert result == [{
            'key': 'product', 'label': 'Product', 'infer': False,
            'values': [{'name': 'app', 'label': 'Mobile app'}],
        }]

    def test_infer_defaults_to_true_and_label_to_the_key(self):
        assert validate_dimensions([{'key': 'segment'}]) == [
            {'key': 'segment', 'label': 'segment', 'infer': True, 'values': []},
        ]

    def test_none_means_no_dimensions(self):
        assert validate_dimensions(None) == []

    def test_a_child_keeps_its_parent_and_parent_values(self):
        module = _product_and_module()[1]
        assert module['parent'] == 'product'
        assert module['values'][0] == {'name': 'checkout', 'parent_value': 'web'}

    def test_the_settings_key_is_the_contract_row(self):
        assert DIMENSIONS_SETTINGS_KEY == {'pk': 'SETTINGS#dimensions', 'sk': 'config'}


class TestValidateDimensionsLimits:
    def test_ten_dimensions_are_accepted(self):
        assert len(validate_dimensions([_dim(f'd{i}') for i in range(10)])) == 10

    def test_eleven_dimensions_are_refused(self):
        assert _refusal([_dim(f'd{i}') for i in range(11)]) == 'At most 10 dimensions are allowed'

    def test_two_hundred_values_are_accepted(self):
        values = [{'name': f'v{i}'} for i in range(200)]
        assert len(validate_dimensions([_dim(values=values)])[0]['values']) == 200

    def test_two_hundred_and_one_values_are_refused(self):
        values = [{'name': f'v{i}'} for i in range(201)]
        assert _refusal([_dim(values=values)]) == 'At most 200 values in dimension "product" are allowed'

    def test_a_32_character_key_is_accepted_and_33_refused(self):
        assert validate_dimensions([_dim('k' * 32)])[0]['key'] == 'k' * 32
        assert 'Dimension keys must start' in _refusal([_dim('k' * 33)])

    def test_label_bounds_are_64_characters(self):
        assert validate_dimensions([_dim(label='L' * 64)])[0]['label'] == 'L' * 64
        assert _refusal([_dim(label='L' * 65)]) == 'Dimension label must be at most 64 characters'

    def test_description_bounds_are_300_characters(self):
        assert validate_dimensions([_dim(description='d' * 300)])[0]['description'] == 'd' * 300
        assert _refusal([_dim(description='d' * 301)]) == 'Dimension description must be at most 300 characters'

    def test_value_names_are_bounded_at_64_characters(self):
        assert validate_dimensions([_dim(values=[{'name': 'v' * 64}])])[0]['values'] == [{'name': 'v' * 64}]
        assert 'must be at most 64 characters' in _refusal([_dim(values=[{'name': 'v' * 65}])])

    def test_value_description_bounds_are_300_characters(self):
        assert 'description must be at most 300' in _refusal([_dim(values=[{'name': 'a', 'description': 'd' * 301}])])


class TestValidateDimensionsRefuses:
    @pytest.mark.parametrize('key', ['Product', '1product', 'pro-duct', '', 'pro duct', '_product'])
    def test_malformed_keys(self, key):
        assert 'Dimension keys must start' in _refusal([_dim(key)])

    def test_surrounding_whitespace_on_a_key_is_trimmed_not_refused(self):
        assert validate_dimensions([_dim(' product\n')])[0]['key'] == 'product'

    @pytest.mark.parametrize('key', sorted(RESERVED_DIMENSION_KEYS))
    def test_reserved_keys(self, key):
        assert _refusal([_dim(key)]) == f'"{key}" is reserved and cannot be a dimension key'

    def test_duplicate_keys(self):
        assert _refusal([_dim(), _dim()]) == 'Dimension keys must be unique'

    @pytest.mark.parametrize('name', ['two words', 'a#b', 'a,b', 'a:b', ''])
    def test_malformed_value_names(self, name):
        assert 'names must be 1-64 characters' in _refusal([_dim(values=[{'name': name}])])

    def test_value_names_repeated_ignoring_case(self):
        assert 'must be unique (ignoring case)' in _refusal([_dim(values=[{'name': 'App'}, {'name': 'app'}])])

    @pytest.mark.parametrize('value', ['product', {'key': 'product'}, 3])
    def test_a_non_list(self, value):
        assert _refusal(value) == 'dimensions must be a list'

    def test_a_non_object_entry(self):
        assert _refusal(['product']) == 'Each dimension must be an object'

    def test_a_non_object_value(self):
        assert _refusal([_dim(values=['app'])]) == 'Each dimension value must be an object'

    def test_a_non_list_values(self):
        assert _refusal([_dim(values='app')]) == 'values in dimension "product" must be a list'

    def test_a_non_string_label(self):
        assert _refusal([_dim(label=5)]) == 'Dimension label must be a string'

    @pytest.mark.parametrize('infer', ['true', 1, 0])
    def test_a_non_boolean_infer(self, infer):
        assert _refusal([_dim(infer=infer)]) == 'Dimension infer must be true or false'


class TestValidateDimensionsHierarchy:
    def test_an_unknown_parent(self):
        assert _refusal([_dim(parent='nope')]) == 'Dimension "product" names an unknown parent'

    def test_a_dimension_cannot_be_its_own_parent(self):
        assert _refusal([_dim(parent='product')]) == 'Dimension "product" names an unknown parent'

    def test_only_one_level_of_hierarchy(self):
        dims = [_dim('product'), _dim('module', parent='product'), _dim('feature', parent='module')]
        assert _refusal(dims) == 'Dimension "module" is itself a child, so it cannot be a parent'

    def test_parent_value_must_exist_in_the_parent(self):
        dims = [_dim('product'), _dim('module', parent='product', values=[{'name': 'x', 'parent_value': 'tv'}])]
        assert _refusal(dims) == 'Value "x" of dimension "module" names an unknown parent_value'

    def test_parent_value_without_a_parent(self):
        assert 'has no parent' in _refusal([_dim(values=[{'name': 'x', 'parent_value': 'app'}])])

    def test_the_child_may_be_listed_before_its_parent(self):
        dims = [_dim('module', parent='product', values=[{'name': 'x', 'parent_value': 'app'}]), _dim('product')]
        assert [d['key'] for d in validate_dimensions(dims)] == ['module', 'product']


class TestLoadDimensionsConfig:
    def test_reads_the_settings_row_strongly_consistent_and_normalises_it(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'dimensions': [{'key': 'product', 'values': [{'name': 'app'}]}]}}
        assert load_dimensions_config(table) == [
            {'key': 'product', 'label': 'product', 'infer': True, 'values': [{'name': 'app'}]},
        ]
        table.get_item.assert_called_once_with(Key=DIMENSIONS_SETTINGS_KEY, ConsistentRead=True)

    def test_no_row_means_no_dimensions(self):
        table = MagicMock()
        table.get_item.return_value = {}
        assert load_dimensions_config(table) == []

    def test_a_dynamodb_error_propagates(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError('throttled')
        with pytest.raises(RuntimeError, match='throttled'):
            load_dimensions_config(table)

    def test_a_corrupt_row_is_refused_not_half_applied(self):
        table = MagicMock()
        table.get_item.return_value = {'Item': {'dimensions': [{'key': 'Bad Key'}]}}
        with pytest.raises(ValueError, match='Dimension keys must start'):
            load_dimensions_config(table)


class TestAllowedValues:
    def test_lists_names_in_configured_order(self):
        assert allowed_values(_dim(values=[{'name': 'web'}, {'name': 'app'}])) == ['web', 'app']

    def test_skips_malformed_entries_and_tolerates_missing_values(self):
        assert allowed_values({'values': [{'name': 'a'}, 'b', {'label': 'c'}]}) == ['a']
        assert allowed_values({'key': 'x'}) == []


class TestResolveDimensions:
    def test_keeps_configured_keys_with_allowed_values_in_configured_spelling(self):
        config = _product_and_module()
        assert resolve_dimensions(config, {'product': ' WEB ', 'module': 'Checkout', 'other': 'x'}) == {
            'product': 'web', 'module': 'checkout',
        }

    def test_drops_values_that_are_not_allowed_or_not_strings(self):
        config = _product_and_module()
        assert resolve_dimensions(config, {'product': 'tv', 'module': 7}) == {}

    def test_drops_a_child_whose_parent_value_does_not_match(self):
        config = _product_and_module()
        assert resolve_dimensions(config, {'product': 'app', 'module': 'checkout'}) == {'product': 'app'}

    def test_drops_a_child_with_a_parent_value_when_the_parent_is_unresolved(self):
        assert resolve_dimensions(_product_and_module(), {'module': 'login'}) == {}

    def test_keeps_a_child_value_without_parent_value_under_any_parent(self):
        config = _product_and_module()
        assert resolve_dimensions(config, {'module': 'search'}) == {'module': 'search'}
        assert resolve_dimensions(config, {'product': 'app', 'module': 'search'}) == {
            'product': 'app', 'module': 'search',
        }

    def test_an_empty_config_resolves_nothing(self):
        assert resolve_dimensions([], {'product': 'app'}) == {}


class TestValidateTags:
    def test_trims_drops_blanks_and_case_repeats_preserving_the_first_spelling(self):
        assert validate_tags([' VIP ', 'vip', '', '  ', 'Beta tester', 'beta TESTER']) == ['VIP', 'Beta tester']

    def test_removes_control_characters(self):
        assert validate_tags(['re\x00fund\x7f', '\tbilling\n']) == ['refund', 'billing']

    def test_none_means_no_tags(self):
        assert validate_tags(None) == []

    def test_twenty_tags_are_accepted_and_twenty_one_refused(self):
        assert len(validate_tags([f't{i}' for i in range(20)])) == 20
        with pytest.raises(ValueError, match='At most 20 tags are allowed'):
            validate_tags([f't{i}' for i in range(21)])

    def test_repeats_do_not_count_towards_the_limit(self):
        assert len(validate_tags([f't{i}' for i in range(20)] * 3)) == 20

    def test_an_unbounded_raw_list_is_refused(self):
        with pytest.raises(ValueError, match='At most 100 tags are allowed'):
            validate_tags(['t'] * 101)

    def test_a_64_character_tag_is_accepted_and_65_refused(self):
        assert validate_tags(['t' * 64]) == ['t' * 64]
        with pytest.raises(ValueError, match='Tags must be 1-64 characters'):
            validate_tags(['t' * 65])

    @pytest.mark.parametrize('tag', ['a#b', 'a,b', 'a:b'])
    def test_separator_characters_are_refused(self, tag):
        with pytest.raises(ValueError, match='Tags must be 1-64 characters'):
            validate_tags([tag])

    @pytest.mark.parametrize(('value', 'message'), [('vip', 'tags must be a list'), ([3], 'Each tag must be a string')])
    def test_malformed_input(self, value, message):
        with pytest.raises(ValueError, match=message):
            validate_tags(value)


class TestParseDimsParam:
    @pytest.mark.parametrize('raw', [None, '', '   '])
    def test_absent_or_blank_is_no_filter(self, raw):
        assert parse_dims_param(raw) == {}

    def test_parses_pairs_trimming_around_them(self):
        assert parse_dims_param('product:app, user_type:partner') == {'product': 'app', 'user_type': 'partner'}

    def test_ten_pairs_are_accepted_and_eleven_refused(self):
        assert len(parse_dims_param(','.join(f'd{i}:v' for i in range(10)))) == 10
        with pytest.raises(ValueError, match='at most 10'):
            parse_dims_param(','.join(f'd{i}:v' for i in range(11)))

    @pytest.mark.parametrize('raw', ['product', 'product:', ':app', 'Product:app', 'product:a:b', 'a:b,', 'p:two words'])
    def test_malformed_pairs_are_refused(self, raw):
        with pytest.raises(ValueError, match='dims must be key:value pairs'):
            parse_dims_param(raw)

    def test_a_key_twice_is_refused(self):
        with pytest.raises(ValueError, match='dims names "product" more than once'):
            parse_dims_param('product:app,product:web')


class TestPatterns:
    def test_patterns_refuse_a_trailing_newline_with_match(self):
        assert DIMENSION_KEY_RE.match('product\n') is None
        assert DIMENSION_VALUE_RE.match('app\n') is None
        assert TAG_RE.match('vip\n') is None

    def test_tag_pattern_admits_inner_spaces_but_not_a_leading_one(self):
        assert TAG_RE.match('beta tester') is not None
        assert TAG_RE.match(' beta') is None
