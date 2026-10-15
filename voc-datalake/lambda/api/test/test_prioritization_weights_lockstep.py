"""The backend's composite weights must match the page's own priority score.

`GET /projects/prioritization` returns a `score_spread` per document: the range
of the composite priority score across the reviewers who scored it. "Spread"
only means anything if it is expressed in the unit the page already SORTS by, so
`COMPOSITE_WEIGHTS` in `projects_handler.py` is a copy of the multipliers in the
frontend's `calculatePriorityScore`.

Re-weight one side alone and nothing breaks loudly: the aggregate keeps
answering a number of the right shape, in a different unit than the column it
sits beside. A comment saying the two mirror each other cannot fail CI, which is
why this repo pins cross-language constants with a lockstep test instead — the
same approach as `test_feedback_page_limit_lockstep.py` and
`lambda/shared/test/test_avatar_image_model_lockstep.py`.
"""
import re
from pathlib import Path

import pytest

FRONTEND_SOURCE = 'frontend/src/pages/Prioritization/prioritizationUtils.ts'

# `score.<axis> * <weight>`, in whatever order the expression happens to list
# them — the mapping is what has to agree, not the writing order.
_TERM = re.compile(r'score\.(\w+)\s*\*\s*(\d*\.?\d+)')


def _repo_root() -> Path:
    # lambda/api/test/ -> voc-datalake/
    return Path(__file__).resolve().parents[3]


def _frontend_weights() -> dict[str, float]:
    path = _repo_root() / FRONTEND_SOURCE
    if not path.is_file():
        # A backend test reaching into the frontend tree. Where only the lambda
        # sources are present (packaging, a partial checkout) there is nothing to
        # compare, and skipping beats a failure that says nothing about the code
        # under test.
        pytest.skip(f'{FRONTEND_SOURCE} not present in this tree')
    source = path.read_text(encoding='utf-8')

    marker = 'export const calculatePriorityScore'
    start = source.find(marker)
    assert start != -1, f'{marker} not found in {FRONTEND_SOURCE}'
    # Scope to the function body, so another weighted expression elsewhere in the
    # module cannot satisfy this test.
    end = source.find('\n}', start)
    assert end != -1, f'{marker} body not delimited as expected'

    weights = {axis: float(weight) for axis, weight in _TERM.findall(source[start:end])}
    assert weights, f'no weighted score terms found in {marker}'
    return weights


def _backend_weights() -> dict[str, float]:
    import projects_handler

    return dict(projects_handler.COMPOSITE_WEIGHTS)


class TestPrioritizationWeightsLockstep:
    def test_every_axis_carries_the_same_weight_on_both_sides(self):
        frontend = _frontend_weights()
        backend = _backend_weights()

        assert backend == pytest.approx(frontend), (
            f'COMPOSITE_WEIGHTS is {backend} but calculatePriorityScore uses '
            f'{frontend}. The aggregate\'s score_spread would then be in a '
            'different unit than the number the page sorts by. Change both, or '
            'neither.'
        )

    def test_the_axes_themselves_agree(self):
        """An axis on one side only would make the composite silently ignore it —
        weighted at zero by the backend, or unweighted by the page."""
        import projects_handler

        assert set(_frontend_weights()) == set(projects_handler.SCORE_AXES)

    def test_the_weights_still_sum_to_one(self):
        """So that a composite score stays on the same 0-5 scale as the sliders
        that feed it, which is what makes `score_spread` readable as "how far apart
        two reviewers were, in slider notches"."""
        assert sum(_backend_weights().values()) == pytest.approx(1.0)
