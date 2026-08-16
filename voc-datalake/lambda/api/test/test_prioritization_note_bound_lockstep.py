"""The note bound must be the same number on both sides of the wire.

`PATCH /projects/prioritization` REFUSES a note longer than `MAX_BALLOT_NOTE_LEN`
rather than truncating it, because the characters past the bound are content and
not a number that can be clamped. That decision puts a requirement on the page:
`fetchApi` throws `API Error: 400` and discards the response body, so a bound the
page does not know about arrives as a Save button that appears to do nothing.

So the frontend carries `MAX_NOTE_LENGTH`, used to bound the notes textarea and to
block a save that would be refused. Raise one side alone and nothing breaks loudly
— either the page bounds input the API would have accepted, or it composes a body
the API refuses with no explanation on screen.

THE NUMBER IS NOT THE WHOLE CONTRACT: the UNIT has to match too. `len()` here counts
CODE POINTS; JavaScript's `.length` counts UTF-16 CODE UNITS, and the two differ for
anything outside the basic plane — one emoji is one code point and two code units. A
plain `.length` on the page would therefore refuse a note of 1500 emoji that this
route accepts, quoting a limit the reviewer had not reached. The page spreads the
string to iterate by code point, and the behavioural assertion for that lives in
`prioritizationUtils.test.ts` (`overLongNoteDocuments counts in the API's unit`) —
comparing the two constants here cannot see it, and asserting the page's source text
from Python would break on a rename or a reformat without a defect.

The one place the units are deliberately allowed to differ is `maxLength` on the
textarea, which the DOM defines in code units and which no amount of care can change.
It is left as the stricter of the two on purpose: it bounds TYPING only, so it can
never produce a body this route refuses.

Separate from `test_prioritization_weights_lockstep.py` on purpose: that file pins
the composite weights, and a file named for one constant pair should not quietly
grow a second. Same approach as `test_feedback_page_limit_lockstep.py`.
"""
import re
from pathlib import Path

import pytest

FRONTEND_SOURCE = 'frontend/src/pages/Prioritization/prioritizationUtils.ts'

# `export const MAX_NOTE_LENGTH = 2000`, tolerating the formatting variations a
# linter could introduce (a semicolon, extra spacing) but not a different name.
_BOUND = re.compile(r'export\s+const\s+MAX_NOTE_LENGTH\s*=\s*(\d+)')


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_bound() -> int:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test — the same reasoning as the weights lockstep.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')

    match = _BOUND.search(path.read_text(encoding='utf-8'))
    assert match, (
        f'MAX_NOTE_LENGTH not found in {FRONTEND_SOURCE}. The API refuses an '
        'over-long note, so the page must know the bound to avoid composing a '
        'body it cannot explain the refusal of.'
    )
    return int(match.group(1))


class TestPrioritizationNoteBoundLockstep:
    def test_both_sides_bound_the_note_at_the_same_length(self):
        import projects_handler

        assert projects_handler.MAX_BALLOT_NOTE_LEN == _frontend_bound(), (
            'MAX_BALLOT_NOTE_LEN and the frontend MAX_NOTE_LENGTH disagree. A '
            'lower page bound silently forbids notes the API accepts; a higher '
            'one lets the page send a note the API refuses, and `fetchApi` '
            'discards the reason so the save looks like it did nothing. Change '
            'both, or neither.'
        )

    def test_the_textarea_is_bounded_by_that_constant(self):
        """The constant existing is not the same as the textarea using it.

        Without `maxLength` on the input a reviewer can still type past the bound
        and meet a refusal with no explanation, which is the case the bound was
        duplicated to prevent. Asserted on the shared constant rather than on the
        literal, so hardcoding `2000` in the JSX still fails here.
        """
        row = _repo_root() / 'frontend/src/pages/Prioritization/PRFAQRow.tsx'
        if not row.is_file():
            pytest.skip('PRFAQRow.tsx not present in this tree')

        source = row.read_text(encoding='utf-8')
        assert 'maxLength={MAX_NOTE_LENGTH}' in source, (
            'the notes textarea must be bounded by MAX_NOTE_LENGTH'
        )

    def test_the_page_blocks_a_save_the_api_would_refuse(self):
        """`maxLength` bounds what is TYPED; it does not shorten a note that was
        already over the bound when the page loaded.

        The pre-ballot score map was written by a route with no note bound at all,
        so an over-long note can be read through to a reviewer and is sent back the
        moment they touch a slider on that row. `overLongNoteDocuments` is what
        turns that into a blocked Save with a reason instead of a 400 the page
        cannot report.
        """
        page = _repo_root() / 'frontend/src/pages/Prioritization/Prioritization.tsx'
        if not page.is_file():
            pytest.skip('Prioritization.tsx not present in this tree')

        source = page.read_text(encoding='utf-8')
        assert 'overLongNoteDocuments' in source
