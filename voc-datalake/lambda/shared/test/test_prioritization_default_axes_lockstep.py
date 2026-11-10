"""The backend's default scoring setup must match the JSON the frontend reads.

`schemas/prioritization-default-axes.json` is the frontend's offline default (what
the board shows before the GET answers, and the "Current default" template);
`DEFAULT_AXES` in `shared/prioritization_axes.py` is what the API answers when no
setup is stored. `schemas/` is not bundled into the Lambdas, so the two are copies,
and a re-weight on one side alone would rank the board one way offline and another
online. Replaces the old `calculatePriorityScore` source-parsing lockstep.
"""
import json
from pathlib import Path

import pytest

from shared import prioritization_axes as axes_mod

FIXTURE = Path(__file__).resolve().parents[3] / 'schemas' / 'prioritization-default-axes.json'


@pytest.fixture(scope='module')
def fixture() -> dict:
    if not FIXTURE.is_file():
        pytest.skip(f'{FIXTURE} not present in this tree')
    return json.loads(FIXTURE.read_text(encoding='utf-8'))


class TestDefaultAxesLockstep:
    def test_the_axes_are_identical(self, fixture):
        assert fixture['axes'] == axes_mod.default_axes()

    def test_the_scale_is_identical(self, fixture):
        # "unscored" is 0: the one value below the scale's first position.
        assert fixture['scale'] == {'min': axes_mod.SCALE_MIN, 'max': axes_mod.SCALE_MAX,
                                    'unscored': axes_mod.SCALE_MIN - 1}

    def test_the_bounds_are_identical(self, fixture):
        assert (fixture['max_active_axes'], fixture['max_axes']) == (axes_mod.MAX_ACTIVE_AXES, axes_mod.MAX_AXES)
