"""Mutation-hardening for `shared.batch_get`.

The earlier suite retried once, so every backoff it saw was attempt 1, where
``2 ** attempt`` and ``2 * attempt`` agree (and attempt 2, where they agree
again). It also never looked at the error log a fail-closed read leaves behind.
These tests pin the whole backoff schedule across every attempt and the exact
log line, with exhaustible fakes and a patched sleep.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from shared import batch_get

_STUCK = {'Responses': {}, 'UnprocessedKeys': {'t': {'Keys': [{'pk': 'P#000', 'sk': 'META'}]}}}


class Stuck(Exception):
    pass


def _read_stuck_key() -> None:
    """One key DynamoDB never processes: every attempt is spent, then the failure raises."""
    table = MagicMock()
    table.name = 't'
    table.meta.client.batch_get_item.side_effect = [_STUCK] * batch_get.BATCH_GET_ATTEMPTS
    with pytest.raises(Stuck):
        batch_get.batch_get_all(table, [{'pk': 'P#000', 'sk': 'META'}], failure=Stuck())


class TestFailClosedReadBacksOffExponentiallyAndLogs:
    def test_every_retry_sleeps_twice_as_long_as_the_last(self):
        sleep = MagicMock()
        with patch.object(batch_get.time, 'sleep', sleep):
            _read_stuck_key()

        assert [c.args for c in sleep.call_args_list] == [(0.1,), (0.2,), (0.4,), (0.8,)]

    def test_the_failure_is_logged_with_the_attempt_count(self):
        log = MagicMock()
        with patch.object(batch_get.time, 'sleep'), patch.object(batch_get.logger, 'error', log):
            _read_stuck_key()

        log.assert_called_once_with('BatchGetItem left keys unprocessed', extra={'attempts': 5})
