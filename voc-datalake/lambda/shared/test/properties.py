"""The one Hypothesis profile for the property tests (``*_properties.py`` next to the unit tests).

Every property runs 256 generated cases. A failing case that Hypothesis finds is saved in ``hypothesis-regressions/``
beside this file and replayed first on every later run; the file is committed with the fix, so the case stays a test.
"""
from __future__ import annotations

from pathlib import Path
from typing import Final

from hypothesis import HealthCheck, settings
from hypothesis.database import DirectoryBasedExampleDatabase

REGRESSIONS: Final = Path(__file__).with_name('hypothesis-regressions')

PROPERTY: Final = settings(
    max_examples=256,
    database=DirectoryBasedExampleDatabase(str(REGRESSIONS)),
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)
