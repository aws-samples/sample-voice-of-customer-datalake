"""Capture a handler's OWN `logger.info` lines in a test.

Every `@api_handler` request also emits one `invocation_cost` line (CPU ms,
wall ms, % of allocation; shared/invocation_cost.py, pinned by
shared/test/test_invocation_cost.py and shared/test/test_api.py).
Tests that pin the exact log lines a route writes capture through
`handler_info`, which records every info line except that per-request one.
"""
from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock, patch

COST_LINE = 'invocation_cost'


@contextmanager
def handler_info(logger: Any) -> Iterator[MagicMock]:
    """Patch `logger.info`; yield a mock that saw every line but `invocation_cost`."""
    info = MagicMock()

    def forward(message: Any, *args: Any, **kwargs: Any) -> None:
        if message != COST_LINE:
            info(message, *args, **kwargs)

    with patch.object(logger, 'info', side_effect=forward):
        yield info
