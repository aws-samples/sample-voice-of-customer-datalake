"""``shared.dynamo_values.plain``: the one Decimal → JSON-safe rule.

It replaced five private copies (agents/store, shared/agents_store, memory_store,
prototype_pins, briefing_store). Each class below pins what its former copy did,
so every caller's output for the values it can receive is unchanged.
"""
from __future__ import annotations

import json
from decimal import Decimal
from types import MappingProxyType

import pytest
from boto3.dynamodb.types import Binary

from agents import store as runtime_store
from shared import agents_store, briefing_store, memory_store, prototype_pins
from shared.dynamo_values import plain


class TestTheSharedRule:
    @pytest.mark.parametrize(('value', 'expected'), [
        (Decimal('2'), 2), (Decimal('2.0'), 2), (Decimal('-3'), -3), (Decimal('2.5'), 2.5), (Decimal('0.25'), 0.25),
        ('text', 'text'), (None, None), (True, True), (7, 7), (1.5, 1.5),
    ])
    def test_a_whole_decimal_becomes_an_int_and_any_other_a_float(self, value, expected):
        out = plain(value)
        assert out == expected
        assert type(out) is type(expected)

    def test_nested_containers_are_converted_all_the_way_down(self):
        value = {'a': [Decimal('1'), {'b': (Decimal('0.5'), {Decimal('3'), Decimal('2')})}]}
        assert plain(value) == {'a': [1, {'b': [0.5, [2, 3]]}]}
        json.dumps(plain(value))

    def test_number_sets_sort_numerically_not_as_text(self):
        assert plain({Decimal('10'), Decimal('9')}) == [9, 10]

    def test_unorderable_set_members_are_kept_rather_than_raising(self):
        out = plain({Binary(b'a'), Binary(b'b')})
        assert isinstance(out, list)
        assert sorted(bytes(b) for b in out) == [b'a', b'b']

    def test_the_input_is_not_mutated(self):
        value = {'n': [Decimal('1')]}
        plain(value)
        assert value == {'n': [Decimal('1')]}


class TestAgentsRuntimeStore:
    """agents/store: str() keys, tuples and sets to lists (now in a stable order)."""

    def test_is_the_shared_rule(self):
        assert runtime_store.plain is plain

    def test_non_string_keys_become_strings_and_tuples_lists(self):
        assert plain({1: Decimal('1')}) == {'1': 1}
        assert plain((Decimal('1'), 'a')) == [1, 'a']
        assert plain({Decimal('7')}) == [7]


class TestSharedAgentsStore:
    """shared/agents_store: any Mapping; tuples and sets to lists."""

    def test_is_the_shared_rule(self):
        assert agents_store.plain is plain

    def test_a_read_only_mapping_is_converted(self):
        assert plain(MappingProxyType({'n': Decimal('4')})) == {'n': 4}

    def test_a_string_set_becomes_a_list_of_its_members(self):
        assert plain({'b', 'a'}) == ['a', 'b']


class TestMemoryStore:
    """memory_store: sets and frozensets sorted."""

    def test_is_the_shared_rule(self):
        assert memory_store.plain is plain

    def test_sets_and_frozensets_are_sorted(self):
        assert plain({'b', 'a'}) == ['a', 'b']
        assert plain(frozenset({2, 1})) == [1, 2]


class TestPrototypePins:
    """prototype_pins: a stored pin row (str keys, lists, maps, Decimals) as the API returns it."""

    def test_a_stored_pin_row_reads_back_unchanged_but_for_its_decimals(self):
        row = {'pk': 'FORM#f', 'sk': 'PIN#p', 'pin_id': 'p', 'x': Decimal('0.25'), 'y': Decimal('40'),
               'replies': [{'text': 'ok', 'at': '2026-01-01'}], 'status': 'open'}
        assert prototype_pins.public_pin(row) == {
            'pin_id': 'p', 'x': 0.25, 'y': 40, 'replies': [{'text': 'ok', 'at': '2026-01-01'}], 'status': 'open',
        }


class TestBriefingStore:
    """briefing_store: any Mapping, str() keys, tuples to lists."""

    def test_is_the_shared_rule(self):
        assert briefing_store.plain is plain

    def test_card_facts_keep_their_shape(self):
        facts = {'company': Decimal('3'), 'personal': Decimal('0'), 'top': ('a', 'b'), 'share': Decimal('0.4')}
        assert plain(facts) == {'company': 3, 'personal': 0, 'top': ['a', 'b'], 'share': 0.4}
