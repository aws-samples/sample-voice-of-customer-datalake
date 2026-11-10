"""`shared/dimension_config.py` and the built-in ``feedback_type``: never stored, always read first."""
from unittest.mock import MagicMock

import pytest

from shared.dimension_config import (
    DIMENSIONS_SETTINGS_KEY,
    MAX_DIMENSIONS,
    load_dimensions_config,
    resolve_dimensions,
    validate_dimensions,
    with_builtin_dimensions,
)
from shared.feedback_types import feedback_type_dimension

PRODUCT = {'key': 'product', 'label': 'Product', 'values': [{'name': 'App'}, {'name': 'Web'}]}


def _dims(count: int) -> list[dict]:
    return [{'key': f'd{index}', 'values': [{'name': 'x'}]} for index in range(count)]


def _table(item: dict | None) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {'Item': item} if item is not None else {}
    return table


class TestValidateDropsTheBuiltin:
    def test_the_spa_echoing_the_builtin_back_stores_only_the_admin_dimensions(self):
        validated = validate_dimensions([feedback_type_dimension(), PRODUCT])
        assert [d['key'] for d in validated] == ['product']

    def test_a_stored_legacy_feedback_type_is_superseded(self):
        legacy = {'key': 'feedback_type', 'label': 'Type', 'infer': False,
                  'values': [{'name': 'review'}, {'name': 'bug'}]}
        assert validate_dimensions([legacy, PRODUCT]) == validate_dimensions([PRODUCT])

    def test_an_admin_redefinition_with_padding_is_dropped_too(self):
        assert validate_dimensions([{'key': '  feedback_type ', 'values': [{'name': 'x'}]}]) == []

    def test_a_builtin_entry_that_would_fail_validation_is_dropped_not_refused(self):
        # A bad label type would raise on any other key; the built-in is dropped first.
        assert validate_dimensions([{'key': 'feedback_type', 'label': 42, 'values': 'nope'}]) == []

    def test_the_builtin_flag_is_never_persisted(self):
        validated = validate_dimensions([{**PRODUCT, 'builtin': True}])
        assert 'builtin' not in validated[0]

    def test_builtin_entries_do_not_count_against_the_limit(self):
        validated = validate_dimensions([feedback_type_dimension(), *_dims(MAX_DIMENSIONS)])
        assert len(validated) == MAX_DIMENSIONS

    def test_the_limit_still_applies_to_the_admin_dimensions(self):
        with pytest.raises(ValueError, match=f'At most {MAX_DIMENSIONS}'):
            validate_dimensions([feedback_type_dimension(), *_dims(MAX_DIMENSIONS + 1)])

    def test_a_non_list_is_still_refused(self):
        with pytest.raises(ValueError, match='must be a list'):
            validate_dimensions({'key': 'feedback_type'})

    def test_none_is_no_dimensions(self):
        assert validate_dimensions(None) == []

    def test_non_mapping_entries_are_still_refused(self):
        with pytest.raises(ValueError, match='must be an object'):
            validate_dimensions(['feedback_type'])

    def test_a_child_naming_feedback_type_as_parent_is_refused(self):
        child = {'key': 'kind', 'parent': 'feedback_type', 'values': [{'name': 'x', 'parent_value': 'bug'}]}
        with pytest.raises(ValueError, match='unknown parent'):
            validate_dimensions([feedback_type_dimension(), child])


class TestWithBuiltinDimensions:
    def test_the_builtin_comes_first(self):
        merged = with_builtin_dimensions(validate_dimensions([PRODUCT]))
        assert [d['key'] for d in merged] == ['feedback_type', 'product']
        assert merged[0] == feedback_type_dimension()

    def test_no_stored_dimensions_is_only_the_builtin(self):
        assert with_builtin_dimensions([]) == [feedback_type_dimension()]

    def test_the_input_list_is_not_mutated(self):
        stored = validate_dimensions([PRODUCT])
        with_builtin_dimensions(stored)
        assert [d['key'] for d in stored] == ['product']

    def test_each_call_carries_its_own_builtin_copy(self):
        first = with_builtin_dimensions([])
        first[0]['values'].clear()
        assert with_builtin_dimensions([])[0]['values'] == feedback_type_dimension()['values']


class TestLoadDimensionsConfig:
    def test_nothing_stored_is_the_builtin_only(self):
        table = _table(None)
        assert load_dimensions_config(table) == [feedback_type_dimension()]
        table.get_item.assert_called_once_with(Key=DIMENSIONS_SETTINGS_KEY, ConsistentRead=True)

    def test_stored_dimensions_follow_the_builtin(self):
        loaded = load_dimensions_config(_table({'dimensions': [PRODUCT]}))
        assert [d['key'] for d in loaded] == ['feedback_type', 'product']

    def test_a_stored_legacy_feedback_type_is_replaced_by_the_builtin(self):
        legacy = {'key': 'feedback_type', 'infer': False, 'values': [{'name': 'review'}]}
        loaded = load_dimensions_config(_table({'dimensions': [legacy, PRODUCT]}))
        assert [d['key'] for d in loaded] == ['feedback_type', 'product']
        assert loaded[0] == feedback_type_dimension()

    def test_an_invalid_stored_row_raises(self):
        with pytest.raises(ValueError, match='reserved'):
            load_dimensions_config(_table({'dimensions': [{'key': 'category'}]}))


class TestResolvingAgainstTheBuiltin:
    @pytest.mark.parametrize(('candidate', 'expected'), [
        ('bug', 'bug'),
        ('BUG', 'bug'),
        (' Feature_Request ', 'feature_request'),
    ])
    def test_a_known_type_resolves_to_its_canonical_spelling(self, candidate, expected):
        config = with_builtin_dimensions([])
        assert resolve_dimensions(config, {'feedback_type': candidate}) == {'feedback_type': expected}

    @pytest.mark.parametrize('candidate', ['review', 'complaint', '', None, 3])
    def test_an_unknown_type_is_dropped(self, candidate):
        assert resolve_dimensions(with_builtin_dimensions([]), {'feedback_type': candidate}) == {}
