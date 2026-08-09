"""Lockstep test: backend KIRO_EXPORT_EXCLUDED_TYPES and frontend
KIRO_EXPORTABLE_DOC_TYPES must be complementary subsets of the full
document_type union, and must never drift apart.

The full union is:
    prd | prfaq | research | custom | product_report | prototype

The backend defines which types are EXCLUDED.
The frontend defines which types are INCLUDED (shown in the picker).

Their union must equal the full document_type set, and their intersection
must be empty.  If either changes without the other, this test fails.

Pattern follows test_feedback_page_limit_lockstep.py (same repo) and
lambda/shared/test/test_avatar_image_model_lockstep.py.
"""
import re
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# All values in the `document_type` union from types.ts.
# Kept here so this test fails if someone adds a new type without deciding
# whether it belongs in the export.
ALL_DOCUMENT_TYPES: frozenset[str] = frozenset({
    'prd', 'prfaq', 'research', 'custom', 'product_report', 'prototype',
})

FRONTEND_SOURCE = 'frontend/src/pages/ProjectDetail/autoseedSelection.ts'


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _read(relative: str) -> str:
    path = _repo_root() / relative
    assert path.is_file(), f'{relative} not found — did the file move?'
    return path.read_text(encoding='utf-8')


def _backend_excluded_types() -> frozenset[str]:
    """Read KIRO_EXPORT_EXCLUDED_TYPES from projects.py."""
    source = _read('lambda/api/projects.py')
    # Match: KIRO_EXPORT_EXCLUDED_TYPES: frozenset[str] = frozenset({...})
    match = re.search(
        r"KIRO_EXPORT_EXCLUDED_TYPES\s*[^=]*=\s*frozenset\(\{([^}]+)\}\)",
        source,
    )
    assert match, 'KIRO_EXPORT_EXCLUDED_TYPES not found in lambda/api/projects.py'
    raw = match.group(1)
    # Extract quoted strings from the set literal
    return frozenset(re.findall(r"'([^']+)'", raw))


def _frontend_exportable_types() -> frozenset[str]:
    """Read KIRO_EXPORTABLE_DOC_TYPES from autoseedSelection.ts."""
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    source = path.read_text(encoding='utf-8')
    # Match: export const KIRO_EXPORTABLE_DOC_TYPES = ['prd', 'prfaq', ...] as const
    match = re.search(
        r"export const KIRO_EXPORTABLE_DOC_TYPES\s*=\s*\[([^\]]+)\]\s*as const",
        source,
    )
    assert match, f'KIRO_EXPORTABLE_DOC_TYPES not found in {FRONTEND_SOURCE}'
    raw = match.group(1)
    return frozenset(re.findall(r"'([^']+)'", raw))


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestKiroExportableTypesLockstep:
    def test_frontend_exportable_and_backend_excluded_are_complementary(self):
        """Excluded ∪ Exportable == ALL_DOCUMENT_TYPES and Excluded ∩ Exportable == ∅."""
        excluded = _backend_excluded_types()
        exportable = _frontend_exportable_types()

        union = excluded | exportable
        intersection = excluded & exportable

        assert intersection == frozenset(), (
            f'A type appears in BOTH the backend excluded set and the frontend '
            f'exportable set: {intersection!r}. Remove it from one of them.'
        )
        assert union == ALL_DOCUMENT_TYPES, (
            f'Excluded ∪ Exportable != ALL_DOCUMENT_TYPES.\n'
            f'  Missing from either: {ALL_DOCUMENT_TYPES - union!r}\n'
            f'  Extra (unknown types): {union - ALL_DOCUMENT_TYPES!r}\n'
            f'  If you added a new document_type, decide whether it belongs in '
            f'the Kiro export and update both constants, then update '
            f'ALL_DOCUMENT_TYPES in this test.'
        )

    def test_backend_excludes_prototype(self):
        """Regression pin: prototype is in the excluded set."""
        assert 'prototype' in _backend_excluded_types(), (
            'prototype must be excluded from Kiro exports'
        )

    def test_backend_excludes_product_report(self):
        """Regression pin: product_report is in the excluded set."""
        assert 'product_report' in _backend_excluded_types(), (
            'product_report must be excluded from Kiro exports'
        )

    def test_frontend_exportable_includes_prd(self):
        """Regression pin: prd is in the exportable set."""
        assert 'prd' in _frontend_exportable_types()

    def test_frontend_exportable_includes_prfaq(self):
        """Regression pin: prfaq is in the exportable set."""
        assert 'prfaq' in _frontend_exportable_types()

    def test_frontend_exportable_includes_research(self):
        """Regression pin: research is in the exportable set."""
        assert 'research' in _frontend_exportable_types()

    def test_frontend_exportable_includes_custom(self):
        """Regression pin: custom is in the exportable set."""
        assert 'custom' in _frontend_exportable_types()

    def test_frontend_does_not_export_prototype(self):
        """Regression pin: prototype must NOT be in the exportable set."""
        assert 'prototype' not in _frontend_exportable_types(), (
            'prototype must not be in KIRO_EXPORTABLE_DOC_TYPES'
        )

    def test_frontend_does_not_export_product_report(self):
        """Regression pin: product_report must NOT be in the exportable set."""
        assert 'product_report' not in _frontend_exportable_types(), (
            'product_report must not be in KIRO_EXPORTABLE_DOC_TYPES'
        )
