"""Fixtures for the roadmap gate's tests: a planted repository in a temp dir (planted.py)."""
from __future__ import annotations

from pathlib import Path

import planted
import pytest


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    return planted.plant(tmp_path)
