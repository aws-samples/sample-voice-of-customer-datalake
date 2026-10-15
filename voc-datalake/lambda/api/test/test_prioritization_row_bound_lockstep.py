"""How many documents a row may hold must be the same number on both sides.

`POST /projects/prioritization/rows` TRUNCATES a composition at
`MAX_ROW_DOCUMENT_IDS`, so no row the API writes is longer than that. The page
validates the rows it reads (`RowSchema` in `prioritizationUtils.ts`) and states
the same bound, so the two boundaries describe one contract: a row longer than the
API can produce is a response nothing on the server wrote, and a schema whose whole
purpose is to say what it accepts should refuse it.

Neither side breaks loudly if one moves. A HIGHER page bound accepts a row the API
could never have written, which is the boundary quietly declining to be one. A LOWER
one drops legitimate rows off the list — the row vanishes, its ballots become
unreachable through the page, and nothing says why, because `normalizeRows` drops an
unreadable row rather than marking it (which is right: a row nothing can read has no
documents to show and no title to name it).

Separate from `test_prioritization_note_bound_lockstep.py` for the reason recorded
there: a file named for one constant pair should not quietly grow a second.
"""
import re
from pathlib import Path

import pytest

FRONTEND_SOURCE = 'frontend/src/pages/Prioritization/prioritizationUtils.ts'

# `export const MAX_ROW_DOCUMENT_IDS = 25`, tolerating the formatting variations a
# linter could introduce but not a different name.
_BOUND = re.compile(r'export\s+const\s+MAX_ROW_DOCUMENT_IDS\s*=\s*(\d+)')

# `.max(MAX_ROW_DOCUMENT_IDS)` on the row's document ids — that the constant is
# DECLARED is not the contract; that the schema is bounded BY it is.
#
# `[\s\S]` and a length cap rather than `[^\n]*`: a prettier-style formatter that wraps
# a long zod chain across lines would otherwise fail this test with a message asserting
# the schema is UNBOUNDED — the opposite of the truth, from a Python test that cannot
# see TypeScript formatting. The cap keeps the match local to the `document_ids` field
# rather than letting it reach a `.max()` on some later field of the same object.
_APPLIED = re.compile(r'document_ids:[\s\S]{0,200}?\.max\(\s*MAX_ROW_DOCUMENT_IDS\s*\)')


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_source() -> str:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test — the same reasoning as the note-bound lockstep.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    return path.read_text(encoding='utf-8')


class TestPrioritizationRowBoundLockstep:
    def test_both_sides_bound_a_row_at_the_same_number_of_documents(self):
        import projects_handler

        match = _BOUND.search(_frontend_source())
        assert match, (
            f'MAX_ROW_DOCUMENT_IDS not found in {FRONTEND_SOURCE}. The API truncates '
            'a row composition at that length, so the page has to state the same '
            'bound for its row schema to describe what the API can send.'
        )
        assert projects_handler.MAX_ROW_DOCUMENT_IDS == int(match.group(1)), (
            'MAX_ROW_DOCUMENT_IDS disagrees between projects_handler.py and '
            f'{FRONTEND_SOURCE}. A higher page bound accepts a row the API cannot '
            'write; a lower one silently drops rows the API did write, and a dropped '
            'row takes its ballots off the page with nothing saying why. Change '
            'both, or neither.'
        )

    def test_the_row_schema_is_bounded_by_that_constant(self):
        assert _APPLIED.search(_frontend_source()), (
            f"{FRONTEND_SOURCE} declares MAX_ROW_DOCUMENT_IDS but `document_ids` is "
            'not bounded by it. An unapplied constant is a comment: the schema would '
            'accept a row of any length while claiming to state the API contract.'
        )
