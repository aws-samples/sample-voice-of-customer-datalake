"""Lockstep test: how many research reports a prototype build may name is one
number in two files.

`MAX_SELECTED_RESEARCH_IDS` in lambda/api/projects_handler.py is the enforcing
copy — an over-long `selected_research_ids` is a 400 there, because each id costs
one keyed read. The frontend holds the same number in
frontend/src/pages/ProjectDetail/overviewState.ts, where it decides when the
research tick-boxes stop accepting.

The failure mode is one-sided and quiet: raise the frontend's copy and the picker
happily offers a selection the API rejects, so the build fails on submit, after
the user has chosen, with nothing said about which report to give up. Lower it and
some reports simply become unpickable for no visible reason. Neither shows up in
either file's own tests.

Both literals are read as SOURCE TEXT rather than imported, so the assertion
cannot be satisfied by whatever either module resolves at import time, and it
needs neither the AWS-shaped Python import graph nor a bundler.

Pattern follows test_product_context_placeholder_lockstep.py (same directory).
"""
import re
from pathlib import Path

PYTHON_SOURCE = 'lambda/api/projects_handler.py'
FRONTEND_SOURCE = 'frontend/src/pages/ProjectDetail/overviewState.ts'


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
        f'Expected exactly one MAX_SELECTED_RESEARCH_IDS assignment in {where}; '
        f'found {len(matches)}. A second copy is the drift this test exists to '
        f'prevent — if the declaration was restructured, update this helper.'
    )
    return int(matches[0])


def test_the_research_selection_bound_is_the_same_number_in_both_files():
    python_value = _single_int(
        _read(PYTHON_SOURCE),
        r'^MAX_SELECTED_RESEARCH_IDS\s*=\s*(\d+)',
        PYTHON_SOURCE,
    )
    frontend_value = _single_int(
        _read(FRONTEND_SOURCE),
        r'^export const MAX_SELECTED_RESEARCH_IDS\s*=\s*(\d+)',
        FRONTEND_SOURCE,
    )

    assert python_value == frontend_value, (
        f'{PYTHON_SOURCE} allows {python_value} research ids but '
        f'{FRONTEND_SOURCE} offers {frontend_value}. The API is the enforcing '
        f'side: whichever is wrong, the two must agree or the picker and the '
        f'validator disagree in front of the user.'
    )


def test_the_bound_is_a_plausible_selection_size():
    """A bound that is 0 or 1 would make the feature useless while keeping the
    lockstep test green, and an enormous one would defeat its purpose — the whole
    reason it exists is that each id is a read."""
    value = _single_int(
        _read(PYTHON_SOURCE),
        r'^MAX_SELECTED_RESEARCH_IDS\s*=\s*(\d+)',
        PYTHON_SOURCE,
    )

    assert 2 <= value <= 50
