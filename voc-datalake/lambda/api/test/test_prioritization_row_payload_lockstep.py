"""Every field the API publishes on a row must be one the page declares.

`_row_payload` in `projects_handler.py` is the row as it goes on the wire, and
`RowSchema` in `prioritizationUtils.ts` is the row as the page accepts it. The
schema is a `z.object`, and zod's default object STRIPS an undeclared key rather
than failing on it — so a field the API adds and the page does not declare is
discarded silently at the boundary. Nothing breaks, nothing logs, and the page
simply never learns the thing the API went to the trouble of telling it.

`is_frozen` is exactly that shape of field: it says a ballot has landed so the
composition can no longer change, and a page that never receives it offers an edit
control the server then refuses. The failure is invisible on both sides, which is
why it is pinned here rather than left to a comment claiming the two agree.

ONE DIRECTION ONLY. A key the API sends must be declared; a key the schema declares
need not be sent, because every optional field of the schema carries a `.catch()`
fallback and a page tolerating a field the API has retired is how a client survives
a deployment where the two halves ship at different moments.

Separate from `test_prioritization_row_bound_lockstep.py` for the reason recorded
there: a file named for one contract should not quietly grow a second. That one pins
a NUMBER the two sides must agree on; this one pins the SET OF FIELDS.
"""
import re
from pathlib import Path

import pytest

FRONTEND_SOURCE = 'frontend/src/pages/Prioritization/prioritizationUtils.ts'

# The `RowSchema = z.object({ ... })` literal, and then the field names declared
# inside it. Matched as a block rather than by scanning the whole file, so a `row_id:`
# belonging to some other schema cannot satisfy this one.
_SCHEMA = re.compile(r'const\s+RowSchema\s*=\s*z\.object\(\{(.*?)\n\}\)', re.DOTALL)
_FIELD = re.compile(r'^\s*([a-z_][a-z0-9_]*)\s*:', re.MULTILINE)


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _declared_fields() -> set[str]:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test — the same reasoning as the other locksteps that cross this
        # boundary (`test_prioritization_row_bound_lockstep.py`,
        # `test_prioritization_scorable_types_lockstep.py`).
        #
        # The ones comparing two BACKEND sources assert instead
        # (`test_anon_row_mark_lockstep.py`), and correctly: those files ship together
        # with the test, so an absent one means the file moved rather than that this
        # checkout never had it.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    match = _SCHEMA.search(path.read_text(encoding='utf-8'))
    assert match, (
        f'RowSchema not found in {FRONTEND_SOURCE}. It is the shape the page accepts '
        'a row in, and without it this test cannot tell whether a published field '
        'reaches the page at all.'
    )
    return set(_FIELD.findall(match.group(1)))


def _published_fields() -> set[str]:
    import projects_handler

    # An empty row rather than a realistic one: what is asserted is the KEY SET the
    # payload always carries, and every field of it is unconditional.
    return set(projects_handler._row_payload({}))


class TestPrioritizationRowPayloadLockstep:
    def test_every_published_field_is_one_the_page_declares(self):
        undeclared = _published_fields() - _declared_fields()

        assert not undeclared, (
            f'_row_payload publishes {sorted(undeclared)}, which RowSchema in '
            f'{FRONTEND_SOURCE} does not declare. `z.object` STRIPS what it does not '
            'declare, so those fields are discarded at the boundary in silence: the '
            'page never sees them and nothing fails to say so. Declare each one with '
            'a `.catch()` fallback, or stop publishing it.'
        )

    def test_the_two_sides_still_agree_on_the_fields_the_page_renders(self):
        """The fields both halves have always carried, named so a rename on either
        side fails here rather than emptying a column on the page."""
        both = _published_fields() & _declared_fields()

        assert {'row_id', 'project_id', 'document_ids', 'prototype_id',
                'is_default', 'created_at'} <= both

    def test_the_frozen_flag_reaches_the_page(self):
        """Named on its own because it is the field this test was written for: the
        composition freeze is enforced by a database condition, and `is_frozen` is the
        only thing that lets the page say so before the refusal arrives."""
        assert 'is_frozen' in _published_fields()
        assert 'is_frozen' in _declared_fields()

    def test_the_stored_freeze_instant_and_write_count_stay_unpublished(self):
        """The other direction of the same contract. The instant would invite a client
        to compute the freeze itself and eventually disagree with the condition that
        enforces it, and `ballot_writes` counts WRITES rather than reviewers — a number
        that looks like a reviewer count but is not is worse than no number."""
        import projects_handler

        published = _published_fields()
        assert projects_handler.ROW_FROZEN_AT_FIELD not in published
        assert projects_handler.ROW_BALLOT_WRITES_FIELD not in published
