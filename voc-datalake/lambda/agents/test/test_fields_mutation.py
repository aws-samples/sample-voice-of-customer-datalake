"""agents.fields under mutation.

mutmut can only replace ``source.get(key)`` here, and both of those mutants were already
dead on arrival. What the earlier tests could not see are the mutants mutmut does not
generate: widening ``isinstance(value, dict)`` to ``Mapping`` (a read-only mapping proxy
would then leak through as a non-dict), narrowing it to ``type(value) is dict`` (a dict
subclass would be dropped), and sharing one module-level ``{}``/``[]`` instead of
returning a fresh empty value each call — the docstring promises a fresh one, and a
caller that mutates the result relies on it. These tests pin those three contracts.
"""
from __future__ import annotations

from collections import OrderedDict, UserDict, UserList
from types import MappingProxyType

import pytest

from agents.fields import dict_field, list_field


class _DictSubclass(dict):
    pass


class _ListSubclass(list):
    pass


class TestOnlyTheExactBuiltinFamilyPasses:
    @pytest.mark.parametrize('inner', [OrderedDict(a=1), _DictSubclass(a=1)])
    def test_a_dict_subclass_is_returned_as_the_same_object(self, inner):
        assert dict_field({'k': inner}, 'k') is inner

    @pytest.mark.parametrize('value', [MappingProxyType({'a': 1}), UserDict(a=1)])
    def test_a_non_dict_mapping_is_replaced_by_an_empty_dict(self, value):
        result = dict_field({'k': value}, 'k')
        assert result == {}
        assert type(result) is dict

    def test_a_list_subclass_is_returned_as_the_same_object(self):
        inner = _ListSubclass([1])
        assert list_field({'k': inner}, 'k') is inner

    @pytest.mark.parametrize('value', [UserList([1]), range(2), (1,), b'ab'])
    def test_a_non_list_sequence_is_replaced_by_an_empty_list(self, value):
        result = list_field({'k': value}, 'k')
        assert result == []
        assert type(result) is list


class TestTheEmptyFallbackIsFreshEveryCall:
    def test_two_dict_fallbacks_are_distinct_objects(self):
        first = dict_field({}, 'k')
        second = dict_field({'k': 'not a dict'}, 'k')
        assert first is not second
        first['x'] = 1
        assert second == {}

    def test_two_list_fallbacks_are_distinct_objects(self):
        first = list_field({}, 'k')
        second = list_field({'k': 'not a list'}, 'k')
        assert first is not second
        first.append(1)
        assert second == []


class TestTheLookupIsAPlainGetOnTheKey:
    def test_the_key_is_read_from_the_source_not_a_neighbour(self):
        inner = {'a': 1}
        source = {'other': {'b': 2}, 'k': inner}
        assert dict_field(source, 'k') is inner
        assert dict_field(source, 'absent') == {}

    def test_a_read_only_mapping_source_is_accepted(self):
        source = MappingProxyType({'k': [1]})
        assert list_field(source, 'k') == [1]
        assert list_field(source, 'z') == []
