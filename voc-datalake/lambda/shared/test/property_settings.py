"""The one Hypothesis settings object the property tests (`test_*_properties.py`) run under.

256 examples per property. No deadline: the per-example deadline would make a slow machine (or a mutant run, where
every call goes through mutmut's trampoline) fail a property for time, not for a wrong answer; the run as a whole is
bounded by pytest's and mutmut's own timeouts.

Under mutmut (`MUTANT_UNDER_TEST` is set in its runs) the examples are derandomized and the example database is off,
so every mutant meets the same 256 inputs as the clean run and a score does not move between two runs of one tree.
The `differing_executors` health check is off for the same runs only: mutmut runs one test several times in one
process (stats, the clean run, then each mutant), each time on a fresh instance of the test class, which is what
that check reports; the properties keep no state on `self`.
"""

from __future__ import annotations

import os

from hypothesis import HealthCheck, settings

_UNDER_MUTMUT = bool(os.environ.get('MUTANT_UNDER_TEST'))

PROPERTY = (
    settings(
        max_examples=256,
        deadline=None,
        derandomize=True,
        database=None,
        suppress_health_check=(HealthCheck.differing_executors,),
    )
    if _UNDER_MUTMUT
    else settings(max_examples=256, deadline=None)
)
