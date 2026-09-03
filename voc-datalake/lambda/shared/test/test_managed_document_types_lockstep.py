"""Lockstep: which document types the backend MANAGES a version for, and which
types the frontend believes are managed, must not drift apart.

The backend owns the contract. `shared.document_versions.VERSIONED_DOCUMENT_TYPES`
decides which types get a stored `base_title`/`version` and a canonical `(vN)`
title; `MANAGED_SORT_KEY_PREFIXES` is the same set keyed by the sort-key prefix a
legacy row carries instead.

The frontend has to know the SAME set for one reason: `ordinalByType` derives a
contextual "2 of 3" from creation ORDER, and `isVersionManagedDocument` is what
suppresses it for a type whose number the backend stores. Get the set wrong in
either direction and the failure is a wrong number rather than an error:

  * a managed type MISSING from the frontend set shows an order-derived ordinal
    beside a stored `(vN)` that disagrees with it, and renumbers every older
    document whenever a new one arrives — exactly the defect that made research a
    managed type;
  * an unmanaged type ADDED to the frontend set suppresses the only number that
    type ever had, because the backend stores none for it.

Nothing tied the two languages together, and `tsc` and pytest are both silent on
the disagreement. Same pattern as `test_doc_type_lockstep.py`.

The extraction is deliberately literal — a `new Set([...])` of quoted strings and
an array of quoted strings — and each parser carries a positive AND a negative
control below, so an empty read cannot pass as agreement.
"""
import re
from pathlib import Path

import pytest

from shared.document_versions import (
    MANAGED_SORT_KEY_PREFIXES,
    VERSIONED_DOCUMENT_TYPES,
)

#: The frontend's copy of the set, and the one predicate every surface reaches it
#: through (`DocumentsTab`, `ProjectModals`, `ProjectDetail`).
LINEAGE_SOURCE = 'frontend/src/api/documentLineage.ts'
#: The wire-boundary normalizer's copy, used to recover `document_type` from a
#: legacy row's sort key before Zod parses it.
SCHEMA_SOURCE = 'frontend/src/api/projectDetailSchema.ts'

_QUOTED = re.compile(r"""['"]([^'"]+)['"]""")


def _repo_root() -> Path:
    # lambda/shared/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _source(relative: str) -> str:
    return (_repo_root() / relative).read_text(encoding='utf-8')


def _frontend_present() -> bool:
    return (_repo_root() / LINEAGE_SOURCE).is_file()


def _declared_set(source: str, name: str) -> set[str]:
    """Members of `const {name} = new Set([...])`, or an empty set if unreadable.

    Empty is never treated as agreement: `parses_a_declared_set` and
    `reads_nothing_from_a_declaration_it_cannot_find` below pin both outcomes, and
    every assertion in this file compares against a NON-empty backend set, so an
    unreadable declaration fails rather than passes.
    """
    match = re.search(
        rf'const\s+{re.escape(name)}\s*=\s*new Set\(\[(.*?)\]\)',
        source,
        re.DOTALL,
    )
    return set(_QUOTED.findall(match.group(1))) if match else set()


def _declared_array(source: str, name: str) -> list[str]:
    """Members of `const {name} = [...]`, in declaration order."""
    match = re.search(
        rf'const\s+{re.escape(name)}\s*=\s*\[(.*?)\]',
        source,
        re.DOTALL,
    )
    return _QUOTED.findall(match.group(1)) if match else []


requires_frontend = pytest.mark.skipif(
    not _frontend_present(),
    reason=f'{LINEAGE_SOURCE} is absent; nothing to compare against',
)


def test_the_backend_set_is_non_empty_and_matches_its_prefix_map():
    """Anti-vacuous, and it also pins the two backend halves together: a type in
    one and not the other is recognised on a row that stores `document_type` and
    not on a legacy row that does not."""
    assert VERSIONED_DOCUMENT_TYPES
    assert set(MANAGED_SORT_KEY_PREFIXES.values()) == set(VERSIONED_DOCUMENT_TYPES)
    for prefix, managed_type in MANAGED_SORT_KEY_PREFIXES.items():
        assert prefix == f'{managed_type.upper()}#', (
            f'{prefix!r} does not name {managed_type!r}; a stored row uses '
            f'{managed_type.upper()}# as its sort-key prefix.'
        )


@requires_frontend
def test_the_frontend_lineage_set_matches_the_backend_exactly():
    frontend = _declared_set(
        _source(LINEAGE_SOURCE), 'VERSION_MANAGED_DOCUMENT_TYPES',
    )

    assert frontend == set(VERSIONED_DOCUMENT_TYPES), (
        f'VERSION_MANAGED_DOCUMENT_TYPES in {LINEAGE_SOURCE} is {sorted(frontend)} '
        f'but the backend manages {sorted(VERSIONED_DOCUMENT_TYPES)}. A missing '
        f'type shows an order-derived ordinal beside a stored (vN); an extra one '
        f'suppresses the only number that type has.'
    )


@requires_frontend
def test_the_frontend_legacy_prefixes_match_the_backend_exactly():
    frontend = _declared_array(
        _source(LINEAGE_SOURCE), 'VERSION_MANAGED_SK_PREFIXES',
    )

    assert set(frontend) == set(MANAGED_SORT_KEY_PREFIXES), (
        f'VERSION_MANAGED_SK_PREFIXES in {LINEAGE_SOURCE} is {sorted(frontend)} '
        f'but the backend recognises {sorted(MANAGED_SORT_KEY_PREFIXES)}.'
    )


@requires_frontend
def test_the_wire_normalizer_recovers_every_managed_type_from_a_legacy_sort_key():
    """`withLegacyManagedDocumentType` lower-cases the sort-key stem, so its set is
    the managed types themselves rather than the `PRD#` prefixes."""
    frontend = _declared_set(_source(SCHEMA_SOURCE), 'LEGACY_MANAGED_TYPES')

    assert frontend == set(VERSIONED_DOCUMENT_TYPES), (
        f'LEGACY_MANAGED_TYPES in {SCHEMA_SOURCE} is {sorted(frontend)} but the '
        f'backend manages {sorted(VERSIONED_DOCUMENT_TYPES)}. A legacy row of a '
        f'missing type arrives with no document_type and is dropped at the wire '
        f'boundary.'
    )


class TestTheParsersAreNotVacuous:
    """Each extraction reads a real declaration AND returns nothing for one it
    cannot find — so an empty result can never be mistaken for agreement."""

    def test_parses_a_declared_set(self):
        assert _declared_set(
            "const Managed = new Set(['prd', \"prfaq\"])", 'Managed',
        ) == {'prd', 'prfaq'}

    def test_parses_a_declaration_broken_across_lines(self):
        assert _declared_set(
            "const Managed = new Set([\n  'prd',\n  'prfaq',\n])", 'Managed',
        ) == {'prd', 'prfaq'}

    def test_reads_nothing_from_a_declaration_it_cannot_find(self):
        assert _declared_set("const Other = new Set(['prd'])", 'Managed') == set()

    def test_does_not_confuse_a_similarly_named_declaration(self):
        # `Managed` must not be read out of `ManagedLegacy`.
        source = "const ManagedLegacy = new Set(['research'])"
        assert _declared_set(source, 'Managed') == set()

    def test_parses_a_declared_array_in_order(self):
        assert _declared_array(
            "const Prefixes = ['PRD#', 'PRFAQ#']", 'Prefixes',
        ) == ['PRD#', 'PRFAQ#']

    def test_reads_nothing_from_an_array_it_cannot_find(self):
        assert _declared_array("const Other = ['PRD#']", 'Prefixes') == []
