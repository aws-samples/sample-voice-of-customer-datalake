"""Mutation hardening for `shared/dimension_config.py`.

`test_dimension_config.py` pins the bounds and which inputs are refused, but
mostly with `pytest.raises(match=...)` / `in`, a substring search. A mutation
run found what that cannot see:

* the WORDING of every refusal. `PUT /settings/dimensions` and the `dims`
  query parameter return `str(exc)` as the 400 body, so each message is
  pinned here as a whole literal (a `XX...XX`-wrapped or `None`-labelled
  message passes a substring match).
* a value's `description` key on the way out, and that a later invalid
  `parent_value` is still checked after a value that has none.
* `resolve_dimensions` resolving parents first whatever the config order,
  and carrying on past a dropped child to the next one.
* a malformed (nameless) configured value never matching a candidate.
"""
from collections.abc import Callable

import pytest

from shared import dimension_config
from shared.dimension_config import parse_dims_param, resolve_dimensions, validate_dimensions, validate_tags


def _message(call: Callable[[object], object], value: object) -> str:
    with pytest.raises(ValueError, match=r'.') as exc_info:
        call(value)
    return str(exc_info.value)


def _product(**value_fields: object) -> list[dict]:
    return [{'key': 'product', 'values': [{'name': 'app', **value_fields}]}]


class TestEveryDimensionRefusalIsTheWholeMessage:
    @pytest.mark.parametrize(('value', 'expected'), [
        (_product(name=3), 'Dimension "product" value name must be a string'),
        (_product(name='a b'),
         'Dimension "product" value names must be 1-64 characters with no spaces, "#", "," or ":"'),
        (_product(label='L' * 65), 'Dimension "product" value label must be at most 64 characters'),
        (_product(parent_value='p' * 65), 'Dimension "product" value parent_value must be at most 64 characters'),
        ([{'key': 'product', 'values': [{'name': 'App'}, {'name': 'app'}]}],
         'Value names in dimension "product" must be unique (ignoring case)'),
        ([{'key': 7}], 'Dimension key must be a string'),
        ([{'key': 'Bad'}],
         'Dimension keys must start with a lowercase letter and use only a-z, 0-9 and "_" (at most 32)'),
        ([{'key': 'product', 'parent': 5}], 'Dimension parent must be a string'),
        (_product(parent_value='web'), 'Dimension "product" has no parent, so its values cannot set parent_value'),
    ])
    def test_refusal(self, value: object, expected: str):
        assert _message(validate_dimensions, value) == expected


class TestValueFieldsAndHierarchyChecks:
    def test_a_value_description_is_kept_under_its_own_key(self):
        assert validate_dimensions(_product(description=' Mobile ')) == [
            {'key': 'product', 'label': 'product', 'infer': True, 'values': [{'name': 'app', 'description': 'Mobile'}]},
        ]

    def test_a_bad_parent_value_after_a_value_without_one_is_still_refused(self):
        dims = [
            {'key': 'product', 'values': [{'name': 'app'}]},
            {'key': 'module', 'parent': 'product', 'values': [{'name': 'a'}, {'name': 'b', 'parent_value': 'tv'}]},
        ]
        assert _message(validate_dimensions, dims) == 'Value "b" of dimension "module" names an unknown parent_value'


_PARENT = {'key': 'product', 'values': [{'name': 'app'}, {'name': 'web'}]}
_CHECKOUT = {'key': 'module', 'parent': 'product', 'values': [{'name': 'checkout', 'parent_value': 'web'}]}
_FEATURE = {'key': 'feature', 'parent': 'product', 'values': [{'name': 'cart', 'parent_value': 'app'}]}


class TestResolveDimensionsOrderAndSkips:
    def test_a_parent_listed_after_its_child_is_resolved_first(self):
        config = validate_dimensions([_CHECKOUT, _PARENT])
        assert resolve_dimensions(config, {'module': 'checkout', 'product': 'web'}) == {
            'product': 'web', 'module': 'checkout',
        }

    def test_a_dropped_child_does_not_stop_the_next_one(self):
        config = validate_dimensions([_PARENT, _CHECKOUT, _FEATURE])
        assert resolve_dimensions(config, {'product': 'app', 'module': 'checkout', 'feature': 'cart'}) == {
            'product': 'app', 'feature': 'cart',
        }

    def test_a_parent_value_under_a_dimension_without_a_parent_is_dropped(self):
        config = [{'key': 'product', 'values': [{'name': 'app', 'parent_value': 'web'}]}]
        assert resolve_dimensions(config, {'product': 'app'}) == {}

    def test_a_nameless_configured_value_never_matches(self):
        config = [{'key': 'product', 'values': [{'label': 'Broken'}, {'name': 'xxxx'}]}]
        assert resolve_dimensions(config, {'product': 'XXXX'}) == {'product': 'xxxx'}


class TestTagAndDimsRefusalsAreTheWholeMessage:
    @pytest.mark.parametrize(('call', 'value', 'expected'), [
        (validate_tags, [3], 'Each tag must be a string'),
        (validate_tags, ['a#b'], 'Tags must be 1-64 characters with no "#", "," or ":"'),
        (parse_dims_param, ','.join(f'd{i}:v' for i in range(11)), 'dims accepts at most 10 key:value pairs'),
        (parse_dims_param, 'product', 'dims must be key:value pairs separated by commas'),
        (parse_dims_param, 'product:app,product:web', 'dims names "product" more than once'),
    ])
    def test_refusal(self, call: Callable[[object], object], value: object, expected: str):
        assert _message(call, value) == expected


def test_every_exported_name_exists():
    assert [name for name in dimension_config.__all__ if not hasattr(dimension_config, name)] == []
