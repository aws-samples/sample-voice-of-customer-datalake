"""Lockstep test: the derivation role vocabulary is closed, and the backend's
copy and the frontend's copy must never drift apart.

The backend writes roles (lambda/shared/derivation.py); the frontend declares,
validates and maps them (frontend/src/api/derivation.ts). Adding a role on the
frontend side is already a compile error there — the role→legacy-field map is
keyed by role — but nothing would otherwise stop the backend from writing a
role the frontend cannot name, which would silently drop that source at the
query boundary. This test is that stop.

Pattern follows lambda/api/test/test_kiro_exportable_types_lockstep.py.
"""
import re
from pathlib import Path

from shared.derivation import DERIVATION_ROLES

FRONTEND_SOURCE = 'frontend/src/api/derivation.ts'


def _frontend_roles() -> tuple[str, ...]:
    """Parse DERIVATION_ROLES out of the frontend module, in declared order."""
    # lambda/shared/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / FRONTEND_SOURCE
    assert path.is_file(), (
        f'{FRONTEND_SOURCE} not found — did the file move? '
        f'If so, update FRONTEND_SOURCE in this test file.'
    )
    source = path.read_text(encoding='utf-8')
    matches = re.findall(
        r"export const DERIVATION_ROLES\s*=\s*\[(.*?)\]\s*as const",
        source,
        re.DOTALL,
    )
    assert len(matches) == 1, (
        f'Expected exactly one DERIVATION_ROLES definition in {FRONTEND_SOURCE}; '
        f'found {len(matches)}.'
    )
    # Anchored to whole entry LINES ("  'reference'," and nothing else) rather
    # than to every quoted run in the array body. The array is JSDoc-commented
    # between entries, and an apostrophe in one of those comments ("the model's
    # input") re-pairs every quote after it: an even number injects a phantom
    # role, an odd number garbles all four. No comment line ends in "',", so
    # scanning entry lines only keeps this immune to the prose around them.
    return tuple(re.findall(r"^\s*'([^']+)',", matches[0], re.MULTILINE))


class TestDerivationRolesLockstep:
    def test_backend_and_frontend_declare_the_same_roles_in_the_same_order(self):
        assert DERIVATION_ROLES == _frontend_roles(), (
            'The derivation role vocabulary is closed and shared. Update both '
            'lambda/shared/derivation.py and frontend/src/api/derivation.ts '
            '(and the frontend role→legacy-field map, which is keyed by role).'
        )

    def test_vocabulary_is_the_four_relations_the_code_creates(self):
        """Pinned literally: a new role is a deliberate product decision about a
        new relation, not an incidental addition."""
        assert _frontend_roles() == (
            'reference',
            'prototype_prd',
            'prototype_prfaq',
            'merge_input',
        )
