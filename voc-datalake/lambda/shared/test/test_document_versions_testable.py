"""The version fill: the lowest free versions a document series gives its unversioned documents.

Two places fill versions: `normalize_document_versions` (every read of a project's documents) and
`_assign_unpersisted_legacy_versions` (the one-time migration of a legacy series, above the counter's floor).
Both once looked for a free number with `while number in used: number += 1`, bounded only by finding one, so a
broken fill (a mutant `number = 1`) never ended. The fill is now `_lowest_free_versions`, which looks at no more
than the documents and the claims it is given and fails at once past that. These pin the versions given, in
words: claimed versions are kept, the rest get the lowest free numbers in creation order, input order is kept,
and a document seen twice under one identity is versioned once.
"""
from __future__ import annotations

from typing import Any

import pytest

from shared import document_versions as dv
from shared.document_versions import normalize_document_versions
from shared.exceptions import ServiceError


def _doc(sk: str, created_at: str, *, title: str = 'Plan', version: object = None, **extra: Any) -> dict[str, Any]:
    document: dict[str, Any] = {'sk': sk, 'created_at': created_at, 'title': title, 'document_type': 'prd', **extra}
    if version is not None:
        document['version'] = version
    return document


def _versions(documents: list[dict[str, Any]]) -> list[int]:
    return [document['version'] for document in normalize_document_versions(documents)]


# ---- normalize_document_versions ----

class TestNormalizeFill:
    def test_unversioned_documents_take_one_two_three_in_creation_order_and_keep_their_input_order(self):
        documents = [_doc('PRD#c', '2026-03'), _doc('PRD#a', '2026-01'), _doc('PRD#b', '2026-02')]
        result = normalize_document_versions(documents)
        assert [document['sk'] for document in result] == ['PRD#c', 'PRD#a', 'PRD#b']
        assert [document['version'] for document in result] == [3, 1, 2]
        assert [document['title'] for document in result] == ['Plan (v3)', 'Plan (v1)', 'Plan (v2)']

    def test_the_fill_skips_every_claimed_version(self):
        documents = [
            _doc('PRD#a', '2026-01', version=2),
            _doc('PRD#b', '2026-02', version=4),
            _doc('PRD#c', '2026-03'),
            _doc('PRD#d', '2026-04'),
            _doc('PRD#e', '2026-05'),
        ]
        assert _versions(documents) == [2, 4, 1, 3, 5]

    def test_a_run_of_claims_from_one_pushes_the_fill_past_it(self):
        documents = [_doc(f'PRD#{n}', f'2026-0{n}', version=n) for n in (1, 2, 3)]
        documents += [_doc('PRD#x', '2026-07'), _doc('PRD#y', '2026-08')]
        assert _versions(documents) == [1, 2, 3, 4, 5]

    def test_a_far_claim_leaves_the_low_numbers_to_the_fill(self):
        documents = [_doc('PRD#a', '2026-01', version=1_000_000), _doc('PRD#b', '2026-02')]
        assert _versions(documents) == [1_000_000, 1]

    def test_a_claim_two_documents_make_goes_to_the_older_and_the_newer_is_filled(self):
        documents = [
            _doc('PRD#new', '2026-02', version=1),
            _doc('PRD#old', '2026-01', version=1),
            _doc('PRD#mid', '2026-01-15', version=2),
        ]
        assert _versions(documents) == [3, 1, 2]

    def test_a_legacy_title_suffix_is_a_claim(self):
        documents = [_doc('PRD#a', '2026-01'), _doc('PRD#b', '2026-02', title='Plan (v1)')]
        assert _versions(documents) == [2, 1]

    def test_each_series_fills_on_its_own(self):
        documents = [
            _doc('PRD#a', '2026-01', title='Plan'),
            _doc('PRD#b', '2026-02', title='Other', version=1),
            _doc('PRD#c', '2026-03', title='Other'),
            _doc('PRFAQ#d', '2026-04', title='Plan', document_type='prfaq'),
        ]
        assert _versions(documents) == [1, 1, 2, 1]

    def test_documents_outside_the_managed_types_are_left_as_they_are(self):
        other = {'sk': 'RESEARCH#a', 'title': 'Notes', 'document_type': 'research'}
        assert normalize_document_versions([other]) == [other]


# ---- _assign_unpersisted_legacy_versions ----

class TestLegacyFill:
    def test_the_fill_starts_above_the_floor_and_skips_the_claimed_versions(self):
        ordered = [_doc('PRD#c', '1'), _doc('PRD#d', '2'), _doc('PRD#e', '3')]
        assigned: dict[str, int] = {}
        dv._assign_unpersisted_legacy_versions(ordered, assigned, {4: 'PRD#a', 6: 'PRD#b'}, 3)
        assert assigned == {'PRD#c': 5, 'PRD#d': 7, 'PRD#e': 8}

    def test_a_run_of_claims_from_the_floor_up_pushes_the_fill_past_it(self):
        ordered = [_doc('PRD#x', '1'), _doc('PRD#y', '2')]
        assigned: dict[str, int] = {}
        dv._assign_unpersisted_legacy_versions(ordered, assigned, {1: 'PRD#a', 2: 'PRD#b', 3: 'PRD#c'}, 0)
        assert assigned == {'PRD#x': 4, 'PRD#y': 5}

    def test_a_document_already_assigned_keeps_its_version(self):
        ordered = [_doc('PRD#a', '1'), _doc('PRD#b', '2')]
        assigned = {'PRD#a': 9}
        dv._assign_unpersisted_legacy_versions(ordered, assigned, {9: 'PRD#a'}, 0)
        assert assigned == {'PRD#a': 9, 'PRD#b': 1}

    def test_an_unused_suffix_above_the_floor_is_reserved_before_the_fill(self):
        ordered = [_doc('PRD#a', '1'), _doc('PRD#b', '2', title='Plan (v3)'), _doc('PRD#c', '3', title='Plan (v1)')]
        assigned: dict[str, int] = {}
        dv._assign_unpersisted_legacy_versions(ordered, assigned, {}, 1)
        # v3 is reserved; v1 is at the floor, so that document is filled like one with no suffix.
        assert assigned == {'PRD#b': 3, 'PRD#a': 2, 'PRD#c': 4}

    def test_one_identity_seen_twice_is_versioned_once(self):
        """Two rows with no sort key share the identity '': the first takes a version, the second is the same."""
        ordered = [_doc('', '1'), _doc('', '2'), _doc('PRD#z', '3')]
        assigned: dict[str, int] = {}
        dv._assign_unpersisted_legacy_versions(ordered, assigned, {}, 0)
        assert assigned == {'': 1, 'PRD#z': 2}

    def test_nothing_to_fill_assigns_nothing(self):
        assigned = {'PRD#a': 1}
        dv._assign_unpersisted_legacy_versions([_doc('PRD#a', '1')], assigned, {1: 'PRD#a'}, 0)
        assert assigned == {'PRD#a': 1}

    def test_the_versions_given_are_recorded_as_used(self):
        used_by = {2: 'PRD#a'}
        dv._assign_unpersisted_legacy_versions([_doc('PRD#b', '1'), _doc('PRD#c', '2')], {}, used_by, 0)
        assert used_by == {2: 'PRD#a', 1: 'PRD#b', 3: 'PRD#c'}


# ---- _lowest_free_versions: the bounded fill both use ----

class TestLowestFreeVersions:
    @pytest.mark.parametrize(('taken', 'start', 'count', 'expected'), [
        (set(), 1, 3, [1, 2, 3]),
        ({1, 3}, 1, 3, [2, 4, 5]),
        ({1, 2, 3}, 1, 2, [4, 5]),
        ({5, 6}, 4, 3, [4, 7, 8]),
        ({100}, 1, 1, [1]),
        ({1}, 1, 0, []),
        (set(), 1, 0, []),
    ])
    def test_the_lowest_free_numbers_from_the_start(self, taken, start, count, expected):
        assert dv._lowest_free_versions(taken, start, count, count + len(taken)) == expected

    def test_the_callers_limit_is_always_enough(self):
        """count + len(taken) numbers hold count free ones however the taken ones lie: the tight case."""
        taken = {1, 2, 3, 4}
        assert dv._lowest_free_versions(taken, 1, 2, 6) == [5, 6]

    def test_a_dict_of_claims_counts_its_keys_as_taken(self):
        assert dv._lowest_free_versions({1: 'PRD#a', 2: 'PRD#b'}, 1, 1, 3) == [3]

    def test_a_fill_that_runs_past_its_limit_fails_at_once(self):
        with pytest.raises(ServiceError) as raised:
            dv._lowest_free_versions({1, 2, 3}, 1, 2, 4)
        assert str(raised.value) == 'Document version fill found 1 of 2 free versions in 4 numbers'

    def test_a_limit_of_nothing_finds_nothing(self):
        with pytest.raises(ServiceError) as raised:
            dv._lowest_free_versions(set(), 1, 1, 0)
        assert str(raised.value) == 'Document version fill found 0 of 1 free versions in 0 numbers'

    def test_the_limit_is_counted_from_the_start(self):
        assert dv._lowest_free_versions({11}, 10, 2, 3) == [10, 12]
        with pytest.raises(ServiceError):
            dv._lowest_free_versions({11}, 10, 2, 2)
