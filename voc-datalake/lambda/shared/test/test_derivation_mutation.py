"""Mutation hardening for `shared/derivation.py`.

`test_derivation.py` pins every shape the module writes — the role vocabulary,
the `sources` entries, the degraded counts, the id-list filtering — and a
mutation run (32 mutants) left exactly one survivor it could not see: the
WORDING of the refusal `derivation_source` raises for a role outside the closed
vocabulary. The earlier test matched the message as an unanchored regex, so a
mutant that padded the text still passed.

That message is the only signal a developer gets when a new ROLE_* was used at
a call site without being declared in `DERIVATION_ROLES` (the frontend gets a
compile error for the same drift). It is pinned here as a literal, anchored at
both ends and including the `repr` of the offending role so an empty or
non-string role is still legible in the traceback.
"""
import re

import pytest

from shared.derivation import derivation_source


def _exactly(message: str) -> str:
    """A `match` pattern that accepts the whole message and nothing else."""
    return f'^{re.escape(message)}$'


class TestUnknownRoleRefusalNamesTheRole:
    @pytest.mark.parametrize(
        ('role', 'message'),
        [
            ('inspired_by', "Unknown derivation role: 'inspired_by'"),
            ('', "Unknown derivation role: ''"),
            ('Reference', "Unknown derivation role: 'Reference'"),
        ],
    )
    def test_message_is_exactly_the_label_and_the_repr_of_the_role(self, role: str, message: str):
        with pytest.raises(ValueError, match=_exactly(message)):
            derivation_source('doc_1', role)

    def test_role_is_checked_before_the_document_id_so_an_absent_source_still_reports_the_bad_role(self):
        """A caller holding `(prd or {}).get('document_id')` (None) with a
        misspelt role must learn about the role, not get a silent None back."""
        with pytest.raises(ValueError, match=_exactly("Unknown derivation role: 'prototype_pfraq'")):
            derivation_source(None, 'prototype_pfraq')
