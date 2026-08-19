"""Lockstep test: how many uploaded visuals a prototype build may name is one
number in two files.

`MAX_SELECTED_PRODUCT_DOC_IDS` in lambda/api/projects_handler.py is the enforcing
copy — an over-long `selected_product_doc_ids` is a 400 there. The frontend holds
the same number in frontend/src/pages/ProjectDetail/overviewState.ts, where it
decides when the visual tick-boxes stop accepting and where a revision slices an
inherited list.

The failure mode is one-sided and quiet, exactly as for the research bound: raise
the frontend's copy and the picker offers a selection the API rejects, so a
billable build fails on submit, after the user has chosen, with nothing said about
which mockup to give up. Lower it and some visuals become unpickable for no visible
reason. Neither shows up in either file's own tests.

This bound differs from the research one in WHY it is small — every selected visual
contributes a palette for the same eight `:root` CSS variables, so a longer list is
contradictory instruction rather than more grounding — which is also why the two
numbers must be allowed to differ from each other while each stays pinned across
the language boundary. Hence a second lockstep test rather than an extra assertion
in the research one.

Both literals are read as SOURCE TEXT rather than imported, so the assertion cannot
be satisfied by whatever either module resolves at import time, and it needs neither
the AWS-shaped Python import graph nor a bundler.

Pattern follows test_research_selection_bound_lockstep.py (same directory).
"""
import re
from pathlib import Path

# The constant moved here from projects_handler so the visual-brief character
# budget could be DERIVED from it — an independently chosen budget had silently
# refused the fourth visual this bound allows. projects_handler imports it.
PYTHON_SOURCE = 'lambda/api/product_context.py'
FRONTEND_SOURCE = 'frontend/src/pages/ProjectDetail/overviewState.ts'

PYTHON_PATTERN = r'^MAX_SELECTED_PRODUCT_DOC_IDS\s*=\s*(\d+)'
FRONTEND_PATTERN = r'^export const MAX_SELECTED_PRODUCT_DOC_IDS\s*=\s*(\d+)'


def _read(relative: str) -> str:
    # lambda/api/test/ -> voc-datalake/
    path = Path(__file__).resolve().parents[3] / relative
    assert path.is_file(), (
        f'{relative} not found — did the file move? '
        f'If so, update the path constant in this test file.'
    )
    return path.read_text(encoding='utf-8')


def _single_int(source: str, pattern: str, where: str) -> int:
    matches = re.findall(pattern, source, re.MULTILINE)
    assert len(matches) == 1, (
        f'Expected exactly one MAX_SELECTED_PRODUCT_DOC_IDS assignment in {where}; '
        f'found {len(matches)}. A second copy is the drift this test exists to '
        f'prevent — if the declaration was restructured, update this helper.'
    )
    return int(matches[0])


def test_the_visual_selection_bound_is_the_same_number_in_both_files():
    python_value = _single_int(_read(PYTHON_SOURCE), PYTHON_PATTERN, PYTHON_SOURCE)
    frontend_value = _single_int(_read(FRONTEND_SOURCE), FRONTEND_PATTERN, FRONTEND_SOURCE)

    assert python_value == frontend_value, (
        f'{PYTHON_SOURCE} allows {python_value} visual ids but '
        f'{FRONTEND_SOURCE} offers {frontend_value}. The API is the enforcing '
        f'side: whichever is wrong, the two must agree or the picker and the '
        f'validator disagree in front of the user.'
    )


def test_the_bound_is_a_plausible_visual_selection_size():
    """A bound of 0 or 1 would make the feature useless — one mockup is not a
    selection — while keeping the lockstep green. A large one would defeat its
    purpose: the reason this number is small is that every visual competes for the
    same eight CSS custom properties, so a long list is contradiction rather than
    grounding."""
    value = _single_int(_read(PYTHON_SOURCE), PYTHON_PATTERN, PYTHON_SOURCE)

    assert 2 <= value <= 10


def test_the_frontend_declaration_keeps_the_shape_this_test_reads():
    """The regex above matches a bare integer at column 0. Folding the constant
    into an object, computing it, or exporting a second assignment would leave this
    file green only because the research lockstep's own helper asserts a single
    match — so assert the shape here too, where the failure names the cause."""
    source = _read(FRONTEND_SOURCE)

    assert 'export const MAX_SELECTED_PRODUCT_DOC_IDS' in source, (
        f'{FRONTEND_SOURCE} no longer exports MAX_SELECTED_PRODUCT_DOC_IDS as a '
        f'top-level const. Keep it a one-line bare integer literal or update '
        f'FRONTEND_PATTERN in this file.'
    )
