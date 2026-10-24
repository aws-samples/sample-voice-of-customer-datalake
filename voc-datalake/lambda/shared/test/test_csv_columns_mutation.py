"""Mutation hardening for `shared/csv_columns.py`.

The mutation run found what `test_csv_columns.py` could not see: most header
aliases were never auto-mapped by any test (a renamed alias or target key
survived), the refusal messages were matched by fragment only, the 200-entry,
256-char, 40/64-char truncation and 1000-char value boundaries were never
probed on both sides, a header after a skipped target or an absent mapped
header was never checked, a non-string metadata value was never offered, and
nothing pinned that a ColumnPlan is immutable.
"""
import dataclasses

import pytest

from shared.csv_columns import ColumnPlan, bounded_metadata, plan_columns

_EVERY_TARGET = 'author, channel, date, id, ignore, metadata, rating, tags, text, title, url'


def _refusal(headers: list[str], column_map: object) -> str:
    """The exact ValueError message ``plan_columns`` refuses ``column_map`` with."""
    try:
        plan_columns(headers, column_map)
    except ValueError as error:
        return str(error)
    pytest.fail('plan_columns accepted the map')


class TestEveryAliasAutoMapsToItsTarget:
    @pytest.mark.parametrize(('header', 'target'), [
        ('text', 'text'), ('review', 'text'), ('comment', 'text'), ('feedback', 'text'),
        ('id', 'id'), ('review_id', 'id'),
        ('rating', 'rating'), ('stars', 'rating'), ('score', 'rating'),
        ('date', 'date'), ('timestamp', 'date'), ('created_at', 'date'),
        ('author', 'author'), ('user', 'author'), ('user_id', 'author'), ('name', 'author'),
        ('title', 'title'), ('subject', 'title'),
        ('url', 'url'), ('link', 'url'),
        ('channel', 'channel'), ('source', 'channel'), ('source_channel', 'channel'),
        ('tags', 'tags'), ('tag', 'tags'), ('labels', 'tags'),
    ])
    def test_a_lone_alias_header(self, header, target):
        plan, warnings = plan_columns([header])
        assert plan == ColumnPlan(single={target: [header]})
        assert warnings == []

    def test_a_skipped_mapped_target_does_not_stop_later_auto_detection(self):
        plan, _ = plan_columns(['Body', 'Stars', 'Link'], {'Body': 'text'})
        assert plan.single == {'text': ['Body'], 'rating': ['Stars'], 'url': ['Link']}
        assert plan.metadata == []


class TestEveryRefusalNamesItsCause:
    def test_a_non_string_target(self):
        assert _refusal(['a'], {'a': 3}) == 'column_map target for "a" must be a string'

    def test_an_unknown_target_lists_every_target_and_cuts_it_at_40_chars(self):
        assert _refusal(['a'], {'a': 'x' * 39 + 'yz'}) == (
            f'column_map target "{"x" * 39}y" for "a" is not one of {_EVERY_TARGET} or dimension:<key>')

    def test_a_non_mapping(self):
        assert _refusal(['a'], ['a']) == 'column_map must be an object of {header: target}'

    def test_more_than_200_entries(self):
        refusal = _refusal(['a'], {f'h{i}': 'metadata' for i in range(201)})
        assert refusal == 'column_map accepts at most 200 entries'

    def test_exactly_200_entries_are_accepted(self):
        _plan, warnings = plan_columns(['a'], {f'h{i}': 'metadata' for i in range(200)})
        assert len(warnings) == 200

    @pytest.mark.parametrize('key', [3, 'h' * 257])
    def test_a_non_string_or_over_256_char_key(self, key):
        assert _refusal(['a'], {key: 'text'}) == 'column_map keys must be CSV header names'

    def test_a_256_char_key_is_a_header_name(self):
        plan, warnings = plan_columns(['h' * 256], {'h' * 256: 'title'})
        assert plan.single == {'title': ['h' * 256]}
        assert warnings == []

    def test_repeated_targets_are_listed_sorted(self):
        refusal = _refusal(['a', 'b', 'c', 'd'], {'a': 'url', 'b': 'url', 'c': 'id', 'd': 'id'})
        assert refusal == 'column_map maps more than one column to id, url'


class TestAbsentMappedHeaders:
    def test_every_absent_header_warns_cut_at_64_chars_and_the_rest_still_maps(self):
        long_name = 'm' * 64 + 'X'
        plan, warnings = plan_columns(['Body'], {long_name: 'author', 'Gone': 'title', 'Body': 'text'})
        assert warnings == [
            f'column_map: no "{"m" * 64}" column in the CSV — ignored',
            'column_map: no "Gone" column in the CSV — ignored',
        ]
        assert plan.single == {'text': ['Body']}


class TestColumnPlanIsImmutable:
    def test_assigning_a_field_raises(self):
        plan, _ = plan_columns(['text'])
        field_name = 'metadata'
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(plan, field_name, [])


class TestBoundedMetadata:
    def test_a_non_string_value_is_skipped_without_a_warning(self):
        assert bounded_metadata({'n': 5, 'k': 'v'}) == ({'k': 'v'}, [])

    def test_a_1000_char_value_stays_and_1001_is_dropped(self):
        out, dropped = bounded_metadata({'ok': 'a' * 1000, 'long': 'b' * 1001})
        assert out == {'ok': 'a' * 1000}
        assert dropped == ['long']

    def test_a_key_is_stripped_and_cut_at_64_chars(self):
        out, dropped = bounded_metadata({' ' + 'k' * 64 + 'Z ': 'v'})
        assert out == {'k' * 64: 'v'}
        assert dropped == []

    def test_a_blank_key_is_dropped(self):
        assert bounded_metadata({'  ': 'v'}) == ({}, ['  '])

    def test_the_31st_entry_is_dropped(self):
        values = {f'm{i:02d}': 'v' for i in range(31)}
        out, dropped = bounded_metadata(values)
        assert list(out) == [f'm{i:02d}' for i in range(30)]
        assert dropped == ['m30']
