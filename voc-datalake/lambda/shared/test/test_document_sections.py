"""`shared/document_sections.py`: the four sections of a project's documents (docs/prototype-builder.md, part 4).

The lockstep half: every `KnownProjectDocumentType` value the SPA knows (`frontend/src/api/types.ts`, parsed
from the file) has its section here, and the server's table holds no type the SPA does not know, so a type added
to one list only fails until both have it with a section.
"""
from __future__ import annotations

import re

import pytest

from shared.document_sections import (
    FALLBACK_SECTION,
    SECTION_BY_TYPE,
    SECTION_ORDER,
    document_section,
    newest_edit_first,
    row_section,
)
from shared.test.repo_paths import repo_root

# The section each type the SPA knows belongs to: written out, not derived from the table under test.
EXPECTED = {
    'prd': 'prd',
    'prfaq': 'prfaq',
    'prototype': 'prototypes',
    'research': 'documents',
    'custom': 'documents',
    'product_report': 'documents',
    'decision': 'documents',
}
_UNION = re.compile(r'export type KnownProjectDocumentType\s*=\s*((?:\s*\|\s*\'[a-z_]+\')+)')


def _spa_document_types() -> list[str]:
    source = (repo_root() / 'frontend' / 'src' / 'api' / 'types.ts').read_text(encoding='utf-8')
    found = _UNION.search(source)
    assert found is not None, 'KnownProjectDocumentType is no longer a union of string literals in types.ts'
    return re.findall(r"'([a-z_]+)'", found.group(1))


class TestTheSpasTypes:
    def test_the_union_parses_out_of_types_ts(self):
        """The positive control (shared/test/repo_paths.py): the comparison below compares against something."""
        assert _spa_document_types() == ['prd', 'prfaq', 'research', 'custom', 'product_report', 'prototype',
                                         'decision']

    def test_the_server_and_the_spa_know_the_same_types(self):
        assert sorted(SECTION_BY_TYPE) == sorted(_spa_document_types())

    @pytest.mark.parametrize('document_type', _spa_document_types())
    def test_every_type_the_spa_knows_is_in_its_section(self, document_type):
        assert document_section(document_type) == EXPECTED[document_type]
        assert document_section(document_type) in SECTION_ORDER


class TestDocumentSection:
    def test_the_order_is_fixed(self):
        assert SECTION_ORDER == ('prd', 'prfaq', 'prototypes', 'documents')
        assert FALLBACK_SECTION == 'documents'

    @pytest.mark.parametrize('document_type', ['a_type_added_later', '', 'PRD', 'prototypes', ' prd'])
    def test_an_unknown_type_is_in_documents(self, document_type):
        assert document_section(document_type) == 'documents'

    @pytest.mark.parametrize('document_type', [None, 7, ['prd'], {'prd': 1}, b'prd', True])
    def test_a_non_string_is_in_documents(self, document_type):
        assert document_section(document_type) == 'documents'

    def test_every_section_in_the_table_is_one_of_the_four(self):
        assert set(SECTION_BY_TYPE.values()) == set(SECTION_ORDER)


class TestRowSection:
    @pytest.mark.parametrize(('sk', 'document_type', 'section'), [
        ('PRD#j', None, 'prd'),
        ('PROTOTYPE#k', None, 'prototypes'),
        ('PRFAQ#l', None, 'prfaq'),
        ('DOC#m', None, 'documents'),
        ('RESEARCH#n', None, 'documents'),
        ('prd#o', None, 'documents'),
        (None, None, 'documents'),
        ('PRD#p', 7, 'prd'),
    ])
    def test_a_legacy_row_with_no_type_is_in_its_sort_keys_section(self, sk, document_type, section):
        """Awaiting the metadata backfill: the sort key read as `_managed_document_type` reads it."""
        assert row_section({'sk': sk, 'document_type': document_type}) == section

    @pytest.mark.parametrize(('sk', 'document_type', 'section'), [
        ('PRD#a', 'custom', 'documents'),
        ('DOC#b', 'prd', 'prd'),
        ('PROTOTYPE#c', 'a_type_added_later', 'documents'),
    ])
    def test_a_type_string_wins_over_the_sort_key(self, sk, document_type, section):
        assert row_section({'sk': sk, 'document_type': document_type}) == section

    def test_a_row_with_neither_is_in_documents(self):
        assert row_section({}) == 'documents'


class TestNewestEditFirst:
    def test_last_edit_first_updated_at_before_created_at_ties_by_id_undated_last(self):
        rows = [
            {'document_id': 'made-late', 'created_at': '2026-03-01'},
            {'document_id': 'undated', 'updated_at': 7},
            {'document_id': 'edited', 'created_at': '2026-01-01', 'updated_at': '2026-04-01'},
            {'document_id': 'tie-b', 'created_at': '2026-02-01', 'updated_at': ''},
            {'document_id': 'tie-a', 'created_at': '2026-01-15', 'updated_at': '2026-02-01'},
        ]
        assert [row['document_id'] for row in newest_edit_first(rows)] == [
            'edited', 'made-late', 'tie-a', 'tie-b', 'undated']

    def test_it_returns_a_new_list_and_leaves_the_rows_as_given(self):
        rows = [{'document_id': 'b'}, {'document_id': 'a'}]
        assert newest_edit_first(rows) == [{'document_id': 'a'}, {'document_id': 'b'}]
        assert rows == [{'document_id': 'b'}, {'document_id': 'a'}]
