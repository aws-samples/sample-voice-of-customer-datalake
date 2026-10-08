"""shared.snapstart: what the mutation run found the earlier tests could not see.

test_snapstart.py pins that a failing warmer is logged with the right message
and that the rest still run, but never read WHICH warmer the log line names:
renaming the ``warmer`` key or breaking the ``__name__`` lookup (so every line
fell back to ``repr``) survived. An operator reading a failed publish's logs
needs that name to know which lazy factory now runs on the first request.
"""

from __future__ import annotations

import functools
import logging

import pytest

from shared import snapstart


def _broken_table() -> object:
    raise RuntimeError('no table')


def _error_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelname == 'ERROR']


class TestTheFailureLogNamesTheWarmer:
    def test_a_named_function_is_logged_by_its_name(self, caplog: pytest.LogCaptureFixture) -> None:
        snapstart.prime((_broken_table,))
        [record] = _error_records(caplog)
        assert record.__dict__['warmer'] == '_broken_table'

    def test_a_callable_without_a_name_is_logged_by_its_repr(self, caplog: pytest.LogCaptureFixture) -> None:
        warmer = functools.partial(_broken_table)
        snapstart.prime((warmer,))
        [record] = _error_records(caplog)
        assert record.__dict__['warmer'] == repr(warmer)
