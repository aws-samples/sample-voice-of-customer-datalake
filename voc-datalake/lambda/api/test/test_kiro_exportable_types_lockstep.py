"""Lockstep test: backend KIRO_EXPORT_EXCLUDED_TYPES and frontend
KIRO_EXPORTABLE_DOC_TYPES must be complementary subsets of the full
document_type union, and must never drift apart.

The full union is parsed dynamically from frontend/src/api/types.ts
(the `document_type` field of `ProjectDocument`), so this test fails
automatically when a new document type is added to the TypeScript union
without also deciding which Kiro constant it belongs in.

The backend defines which types are EXCLUDED.
The frontend defines which types are INCLUDED (shown in the picker).

Their union must equal the full document_type set, and their intersection
must be empty.  If either changes without the other, this test fails.

Pattern follows test_feedback_page_limit_lockstep.py (same repo) and
lambda/shared/test/test_avatar_image_model_lockstep.py.
"""
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# Sources of truth
# ---------------------------------------------------------------------------

# The TypeScript file that defines the document_type union.
# Update this path if the file moves.
TYPES_TS_SOURCE = 'frontend/src/api/types.ts'

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


def _all_document_types() -> frozenset[str]:
    """Parse the document_type union from frontend/src/api/types.ts.

    Matches a line like:
        document_type: 'prd' | 'prfaq' | 'research' | 'custom' | 'product_report' | 'prototype'
    and returns the set of type string values.

    This is the authoritative source: adding a 7th type to the TypeScript union
    causes this helper to return a 7-element set, and the complementarity test
    then fails until KIRO_EXPORT_EXCLUDED_TYPES or KIRO_EXPORTABLE_DOC_TYPES is
    updated to account for it.
    """
    source = _read(TYPES_TS_SOURCE)
    matches = re.findall(
        r"document_type\s*:\s*((?:'[^']+'(?:\s*\|\s*)?)+)",
        source,
    )
    assert len(matches) == 1, (
        f"Expected exactly one 'document_type' union in {TYPES_TS_SOURCE}; "
        f"found {len(matches)}. If another interface also declares document_type, "
        f"anchor the regex to the ProjectDocument interface block."
    )
    raw = matches[0]
    return frozenset(re.findall(r"'([^']+)'", raw))


def _backend_excluded_types() -> frozenset[str]:
    """Read KIRO_EXPORT_EXCLUDED_TYPES from projects.py."""
    source = _read('lambda/api/projects.py')
    # Match: KIRO_EXPORT_EXCLUDED_TYPES: frozenset[str] = frozenset({...})
    matches = re.findall(
        r"KIRO_EXPORT_EXCLUDED_TYPES\s*[^=]*=\s*frozenset\(\{([^}]+)\}\)",
        source,
    )
    assert len(matches) == 1, (
        f"Expected exactly one KIRO_EXPORT_EXCLUDED_TYPES definition in "
        f"lambda/api/projects.py; found {len(matches)}. If the constant "
        f"was renamed or duplicated, update this helper accordingly."
    )
    raw = matches[0]
    # Extract quoted strings from the set literal
    return frozenset(re.findall(r"'([^']+)'", raw))


def _frontend_exportable_types() -> frozenset[str]:
    """Read KIRO_EXPORTABLE_DOC_TYPES from autoseedSelection.ts."""
    path = _repo_root() / FRONTEND_SOURCE
    assert path.is_file(), (
        f'{FRONTEND_SOURCE} not found — did the file move?\n'
        f'If so, update FRONTEND_SOURCE in this test file.'
    )
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
        """Excluded ∪ Exportable == all document_types from types.ts, and Excluded ∩ Exportable == ∅."""
        excluded = _backend_excluded_types()
        exportable = _frontend_exportable_types()
        all_types = _all_document_types()

        union = excluded | exportable
        intersection = excluded & exportable

        assert intersection == frozenset(), (
            f'A type appears in BOTH the backend excluded set and the frontend '
            f'exportable set: {intersection!r}. Remove it from one of them.'
        )
        assert union == all_types, (
            f'Excluded ∪ Exportable != all document_types in {TYPES_TS_SOURCE}.\n'
            f'  Missing from either constant: {all_types - union!r}\n'
            f'  Extra (unknown types not in types.ts): {union - all_types!r}\n'
            f'  If you added a new document_type to types.ts, decide whether it\n'
            f'  belongs in the Kiro export and update KIRO_EXPORT_EXCLUDED_TYPES\n'
            f'  (lambda/api/projects.py) or KIRO_EXPORTABLE_DOC_TYPES\n'
            f'  (frontend/src/pages/ProjectDetail/autoseedSelection.ts).'
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
