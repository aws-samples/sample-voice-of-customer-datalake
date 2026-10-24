"""agents.fields: shape-checked field reads."""
from __future__ import annotations

import pytest

from agents.fields import dict_field, list_field


class TestDictField:
    def test_a_dict_is_returned_as_the_same_object(self):
        inner = {'a': 1}
        assert dict_field({'k': inner}, 'k') is inner

    @pytest.mark.parametrize('value', [None, [], 'x', 3, ['a']])
    def test_anything_else_is_a_fresh_empty_dict(self, value):
        assert dict_field({'k': value}, 'k') == {}

    def test_a_missing_key_is_an_empty_dict(self):
        assert dict_field({}, 'k') == {}


class TestListField:
    def test_a_list_is_returned_as_the_same_object(self):
        inner = [1, 2]
        assert list_field({'k': inner}, 'k') is inner

    @pytest.mark.parametrize('value', [None, {}, 'x', 3, (1, 2)])
    def test_anything_else_is_a_fresh_empty_list(self, value):
        assert list_field({'k': value}, 'k') == []

    def test_a_missing_key_is_an_empty_list(self):
        assert list_field({}, 'k') == []
