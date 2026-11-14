"""shared/carried_values.py: the checks of values a job carries across its hand-overs."""
from __future__ import annotations

import pytest

from shared.carried_values import count_of, flag_or, is_count, key_or_none, mapping_or_empty


def test_a_flag_is_a_bool_and_none_is_the_default():
    assert flag_or(True, 'done', default=False) is True
    assert flag_or(None, 'done', default=True) is True
    with pytest.raises(ValueError, match='done is not a flag'):
        flag_or(1, 'done', default=False)


@pytest.mark.parametrize(('value', 'counts'), [(0, True), (7, True), (-1, False), (True, False), (False, False),
                                               (1.0, False), ('1', False), (None, False)])
def test_a_count_is_a_non_negative_int_never_a_bool(value, counts):
    assert is_count(value) is counts


def test_count_of_names_the_field():
    assert count_of(3, 'total') == 3
    with pytest.raises(ValueError, match='total is not a count'):
        count_of(True, 'total')


def test_mapping_or_empty():
    assert mapping_or_empty(None, 'counts') == {}
    assert mapping_or_empty({'a': 1}, 'counts') == {'a': 1}
    with pytest.raises(ValueError, match='counts is not a mapping'):
        mapping_or_empty(['a'], 'counts')


@pytest.mark.parametrize('value', ['pk', ['pk', 'sk'], {'pk': 'a'}, {'pk': 'a', 'sk': 'b', 'gsi1pk': 'c'},
                                   {'pk': 'a', 'sk': ''}, {'pk': 'a', 'sk': 7}])
def test_a_key_is_exactly_its_attributes_each_a_non_empty_string(value):
    with pytest.raises(ValueError, match='owners is not a key'):
        key_or_none(value, 'owners')


def test_a_key_or_none():
    assert key_or_none(None, 'owners') is None
    assert key_or_none({'pk': 'a', 'sk': 'b'}, 'owners') == {'pk': 'a', 'sk': 'b'}
