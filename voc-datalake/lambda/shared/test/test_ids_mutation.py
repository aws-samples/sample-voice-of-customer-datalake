"""Mutation hardening for `shared/ids.py`.

`test_ids.py` pins the id shape, the transaction cancellation-reason reading and
the one-retry create, but a mutation run found two things it could not see:

* a transactional write (``put_index`` set) refused by an error that carries no
  ``response`` dict — a plain exception, or a botocore-less test double — must
  NOT count as a collision. Every earlier unreadable-reason case still had a
  ClientError response, so ``return True`` on the missing-response branch lived.
* the WORDING of the retry warning, the one line an operator sees in the logs
  when two creates collide inside the same second.

Ids are pinned with a frozen clock and a patched random source, never real time.
"""
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from shared.ids import is_key_collision, timestamped_id, write_with_fresh_id

MOMENT = datetime(2026, 10, 6, 12, 0, 0, tzinfo=UTC)


class _ResponseOnly(Exception):
    def __init__(self, response: object) -> None:
        super().__init__('refused')
        self.response = response


class TestAnErrorWithoutAReadableResponseIsNoTransactionCollision:
    @pytest.mark.parametrize('error', [
        RuntimeError('boom'),
        _ResponseOnly(None),
        _ResponseOnly('TransactionCanceledException'),
        _ResponseOnly([{'Code': 'ConditionalCheckFailed'}]),
    ])
    def test_is_key_collision_answers_false(self, error: Exception):
        assert is_key_collision(error, put_index=0) is False

    def test_write_with_fresh_id_does_not_retry_it(self):
        write = MagicMock(side_effect=RuntimeError('boom'))
        with pytest.raises(RuntimeError, match=r'^boom$'):
            write_with_fresh_id('doc', write, put_index=0, now=MOMENT)
        assert write.call_count == 1


class TestTheRetryIsLoggedVerbatim:
    def test_the_warning_names_the_prefix(self):
        refused = _ResponseOnly({
            'Error': {'Code': 'TransactionCanceledException'},
            'CancellationReasons': [{'Code': 'ConditionalCheckFailed'}],
        })
        write = MagicMock(side_effect=[refused, 'saved'])
        with patch('shared.ids.logger') as logger, \
                patch('shared.ids.secrets.token_hex', side_effect=['0000aaaa', '1111bbbb']):
            assert write_with_fresh_id('note', write, put_index=0, now=MOMENT) == 'saved'
        logger.warning.assert_called_once_with(
            'note id collided with an existing row; retrying once with a new id',
        )
        assert [c.args[0] for c in write.call_args_list] == [
            'note_20261006120000_0000aaaa', 'note_20261006120000_1111bbbb',
        ]


class TestTheDefaultClockIsUtcNow:
    def test_no_reading_stamps_the_current_utc_second(self):
        clock = MagicMock()
        clock.now.return_value = MOMENT
        with patch('shared.ids.datetime', clock), \
                patch('shared.ids.secrets.token_hex', return_value='deadbeef') as token_hex:
            assert timestamped_id('run') == 'run_20261006120000_deadbeef'
        clock.now.assert_called_once_with(UTC)
        token_hex.assert_called_once_with(4)
