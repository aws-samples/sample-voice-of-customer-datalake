"""Property tests of the four sections a project's documents are listed in (shared/document_sections.py).

The rules, in words: every document is in exactly one of the four sections, whatever its type holds; a type
string decides a row's section, and only a row without one is read by its sort key's managed prefix; within a
section the last edit comes first, ties go by document id, and a row with no date sorts last, whatever order
the rows arrive in.
"""
from __future__ import annotations

import itertools
from collections.abc import Sequence

from hypothesis import given
from hypothesis import strategies as st

from shared.document_sections import (
    FALLBACK_SECTION,
    SECTION_BY_TYPE,
    SECTION_ORDER,
    document_section,
    newest_edit_first,
    row_section,
)
from shared.test.property_settings import PROPERTY

KNOWN_TYPES = st.sampled_from(sorted(SECTION_BY_TYPE))
# Types a row may hold that are not the platform's: a later type, another case, a section's own name, padding.
OTHER_TYPES = st.one_of(
    st.sampled_from(['a_type_added_later', '', 'PRD', 'Prototype', 'prototypes', 'documents', ' prd', 'prd ']),
    st.text(max_size=20).filter(lambda text: text not in SECTION_BY_TYPE),
)
NON_STRINGS = st.one_of(st.none(), st.integers(), st.booleans(), st.binary(max_size=5),
                        st.lists(KNOWN_TYPES, max_size=2), st.dictionaries(KNOWN_TYPES, st.integers(), max_size=2))
# The managed sort-key prefixes and the section each one's legacy row is in (written out, not read from the module).
LEGACY_PREFIXES = {'PRD#': 'prd', 'PRFAQ#': 'prfaq', 'PROTOTYPE#': 'prototypes'}
SK_TAILS = st.text(alphabet='abcdefghijklmnopqrstuvwxyz0123456789_#', max_size=24)
OTHER_SKS = st.one_of(
    st.sampled_from(['DOC#a', 'RESEARCH#b', 'prd#c', 'PRD', 'PRFAQ', 'PROTOTYPE', 'XPRD#d', ' PRD#e', 'DECISION#f']),
    st.text(max_size=20).filter(lambda text: not text.startswith(tuple(LEGACY_PREFIXES))),
)
DATES = st.dates().map(lambda day: day.isoformat())
NOT_A_DATE = st.one_of(st.none(), st.just(''), st.integers(), st.just(['2026-01-01']))


class TestEveryDocumentIsInOneOfTheFourSections:
    """Invariant: whatever a document's type holds, its section is one of the four; a known type is in its own
    section, and anything else (a later type, another spelling, a non-string) is in Documents."""

    @PROPERTY
    @given(document_type=st.one_of(KNOWN_TYPES, OTHER_TYPES, NON_STRINGS))
    def test_the_section_is_always_one_of_the_four(self, document_type: object) -> None:
        assert document_section(document_type) in SECTION_ORDER

    @PROPERTY
    @given(document_type=st.one_of(OTHER_TYPES, NON_STRINGS))
    def test_anything_the_platform_does_not_write_is_in_documents(self, document_type: object) -> None:
        assert document_section(document_type) == FALLBACK_SECTION == 'documents'


class TestATypeStringDecidesARowsSectionAndOnlyALegacyRowIsReadByItsSortKey:
    """Invariant: a row whose type is a string is in that type's section whatever its sort key says; a row with no
    type string is in its sort key's managed section (PRD#, PRFAQ#, PROTOTYPE#, case and position exact), else in
    Documents."""

    @PROPERTY
    @given(document_type=st.one_of(KNOWN_TYPES, OTHER_TYPES),
           sk=st.one_of(st.sampled_from(sorted(LEGACY_PREFIXES)).flatmap(lambda p: SK_TAILS.map(p.__add__)),
                        OTHER_SKS, NON_STRINGS))
    def test_a_type_string_wins_over_any_sort_key(self, document_type: str, sk: object) -> None:
        assert row_section({'document_type': document_type, 'sk': sk}) == document_section(document_type)

    @PROPERTY
    @given(prefix=st.sampled_from(sorted(LEGACY_PREFIXES)), tail=SK_TAILS,
           document_type=st.one_of(NON_STRINGS, st.just('absent')))
    def test_a_legacy_row_is_in_its_managed_prefixs_section(self, prefix: str, tail: str, document_type: object) -> None:
        row = {'sk': prefix + tail} if document_type == 'absent' else {'sk': prefix + tail, 'document_type': document_type}
        assert row_section(row) == LEGACY_PREFIXES[prefix]

    @PROPERTY
    @given(sk=st.one_of(OTHER_SKS, NON_STRINGS, st.just('absent')), document_type=NON_STRINGS)
    def test_a_row_with_no_type_and_no_managed_prefix_is_in_documents(self, sk: object, document_type: object) -> None:
        row = {'document_type': document_type} if sk == 'absent' else {'sk': sk, 'document_type': document_type}
        assert row_section(row) == 'documents'


def _rows(ids: Sequence[str | None]) -> st.SearchStrategy[list[dict]]:
    """Rows with these ids, each with any mix of a date edit, a creation date, neither, or a non-date."""
    def row(document_id: str | None) -> st.SearchStrategy[dict]:
        fields = st.fixed_dictionaries({}, optional={'updated_at': st.one_of(DATES, NOT_A_DATE),
                                                     'created_at': st.one_of(DATES, NOT_A_DATE)})
        return fields.map(lambda extra: {'document_id': document_id, **extra})
    return st.tuples(*(row(document_id) for document_id in ids)).map(list)


ROWS = st.lists(st.text(alphabet='abcdef0123', min_size=1, max_size=4), unique=True, max_size=8).flatmap(_rows)


def _edit(row: dict) -> str:
    """The row's last-edit date as the order reads it: updated_at when a non-empty string, else created_at's."""
    for key in ('updated_at', 'created_at'):
        value = row.get(key)
        if isinstance(value, str) and value:
            return value
    return ''


class TestWithinASectionTheLastEditComesFirst:
    """Invariant: the rows come back all of them, once each, the last edit first (updated_at, else created_at),
    ties by document id, a row with no date (none, empty, not a string) last, whatever order they arrived in;
    the caller's list is left as given."""

    @PROPERTY
    @given(rows=ROWS, data=st.data())
    def test_the_order_is_the_last_edit_first_then_the_id(self, rows: list[dict], data: st.DataObject) -> None:
        shuffled = data.draw(st.permutations(rows))
        given_order = list(shuffled)
        ordered = newest_edit_first(shuffled)
        assert shuffled == given_order
        assert sorted(map(id, ordered)) == sorted(map(id, rows))
        keys = [(_edit(row), row['document_id']) for row in ordered]
        for (edit, document_id), (next_edit, next_id) in itertools.pairwise(keys):
            assert edit > next_edit or (edit == next_edit and document_id < next_id)

    @PROPERTY
    @given(rows=ROWS, undated=NOT_A_DATE)
    def test_a_row_with_no_date_sorts_after_every_dated_one(self, rows: list[dict], undated: object) -> None:
        last = {'document_id': '', 'updated_at': undated, 'created_at': undated}
        ordered = newest_edit_first([last, *rows])
        dated = [row for row in ordered if _edit(row)]
        assert ordered[:len(dated)] == dated
        assert last in ordered[len(dated):]

    @PROPERTY
    @given(edit=DATES, ids=st.lists(st.one_of(st.none(), st.integers(), st.text(alphabet='abc', min_size=1, max_size=3)),
                                    min_size=2, max_size=5, unique_by=repr))
    def test_on_one_date_a_row_without_a_string_id_comes_first(self, edit: str, ids: list[object]) -> None:
        rows = [{'document_id': document_id, 'updated_at': edit} for document_id in ids]
        ordered = newest_edit_first(reversed(rows))
        others = [document_id for document_id in reversed(ids) if not isinstance(document_id, str)]
        strings = sorted(document_id for document_id in ids if isinstance(document_id, str))
        assert [row['document_id'] for row in ordered] == others + strings
