"""Test-side clocks: reads of the real UTC clock, and one way to freeze it.

A module-level ``TODAY = datetime.now(UTC)...`` is computed once at import. A suite
that starts before 00:00 UTC and reaches the test after it seeds YESTERDAY's
partition, while the handler under test queries today's — every count reads 0.
Call ``today_utc()`` where the date is used instead.

Code writes "now" stamps through ``shared.timestamps.now_iso``, which reads ITS
``datetime``; a test that freezes a module's clock therefore freezes both with
``frozen_clock(module, fake)``.
"""
import importlib
from collections.abc import Generator
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from types import ModuleType
from typing import Any
from unittest.mock import MagicMock, patch

from shared import timestamps


def today_utc() -> str:
    """Today's ``YYYY-MM-DD`` in UTC, read at the call."""
    return datetime.now(UTC).strftime('%Y-%m-%d')


@contextmanager
def frozen_clock(module: ModuleType | str, fake: Any = None) -> Generator[Any, None, None]:
    """Patch ``module.datetime`` (when the module still imports it) and ``shared.timestamps.datetime`` with ONE
    fake (a ``MagicMock`` by default), so ``now_iso()`` and the module's own reads see the same frozen time."""
    clock = MagicMock() if fake is None else fake
    target = importlib.import_module(module) if isinstance(module, str) else module
    with ExitStack() as stack:
        if hasattr(target, 'datetime'):
            stack.enter_context(patch.object(target, 'datetime', clock))
        stack.enter_context(patch.object(timestamps, 'datetime', clock))
        yield clock
