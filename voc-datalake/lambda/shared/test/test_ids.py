"""shared.ids: collision-safe timestamped ids and the one-retry create."""
import re
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from shared.ids import is_key_collision, timestamped_id, write_with_fresh_id

MOMENT = datetime(2026, 10, 6, 12, 0, 0, tzinfo=UTC)


def _client_error(code: str, reasons: list | None = None) -> ClientError:
    if reasons is None:
        return ClientError({'Error': {'Code': code, 'Message': code}}, 'PutItem')
    return ClientError(
        {'Error': {'Code': code, 'Message': code}, 'CancellationReasons': reasons}, 'PutItem',
    )


class TestTimestampedId:
    def test_the_stamp_comes_first_then_eight_hex(self):
        assert re.fullmatch(r'proj_20261006120000_[0-9a-f]{8}', timestamped_id('proj', MOMENT))

    def test_two_ids_in_the_same_second_differ(self):
        assert timestamped_id('proj', MOMENT) != timestamped_id('proj', MOMENT)

    def test_the_stamp_is_utc_whatever_zone_the_reading_was_in(self):
        local = MOMENT.astimezone(timezone(timedelta(hours=2)))
        assert timestamped_id('doc', local).startswith('doc_20261006120000_')

    def test_ids_still_sort_by_creation_second(self):
        earlier = timestamped_id('proj', MOMENT)
        later = timestamped_id('proj', MOMENT + timedelta(seconds=1))
        assert sorted([later, earlier]) == [earlier, later]


class TestIsKeyCollision:
    def test_a_plain_conditional_put_refusal_is_a_collision(self):
        assert is_key_collision(_client_error('ConditionalCheckFailedException'))

    def test_another_error_is_not(self):
        assert not is_key_collision(_client_error('ProvisionedThroughputExceededException'))

    def test_a_transaction_collides_only_on_the_puts_own_reason(self):
        put_refused = _client_error('TransactionCanceledException',
                                    [{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}])
        meta_refused = _client_error('TransactionCanceledException',
                                     [{'Code': 'None'}, {'Code': 'ConditionalCheckFailed'}])
        assert is_key_collision(put_refused, put_index=0)
        assert not is_key_collision(meta_refused, put_index=0)

    @pytest.mark.parametrize('reasons', [None, [], 'garbled', [None]])
    def test_unreadable_cancellation_reasons_are_not_a_collision(self, reasons):
        assert not is_key_collision(_client_error('TransactionCanceledException', reasons), put_index=0)

    def test_a_plain_refusal_is_not_a_transaction_collision(self):
        assert not is_key_collision(_client_error('ConditionalCheckFailedException'), put_index=0)


class TestWriteWithFreshId:
    def test_the_first_id_is_used_when_it_is_free(self):
        write = MagicMock(side_effect=lambda new_id: new_id)
        with patch('shared.ids.secrets.token_hex', return_value='0000aaaa'):
            assert write_with_fresh_id('proj', write, now=MOMENT) == 'proj_20261006120000_0000aaaa'
        write.assert_called_once()

    def test_a_collision_retries_once_with_a_new_id(self):
        write = MagicMock(side_effect=[_client_error('ConditionalCheckFailedException'), 'saved'])
        with patch('shared.ids.secrets.token_hex', side_effect=['0000aaaa', '1111bbbb']):
            assert write_with_fresh_id('proj', write, now=MOMENT) == 'saved'
        assert [c.args[0] for c in write.call_args_list] == [
            'proj_20261006120000_0000aaaa', 'proj_20261006120000_1111bbbb',
        ]

    def test_a_second_collision_propagates(self):
        error = _client_error('ConditionalCheckFailedException')
        write = MagicMock(side_effect=[error, error])
        with pytest.raises(ClientError):
            write_with_fresh_id('proj', write, now=MOMENT)
        assert write.call_count == 2

    def test_any_other_error_is_not_retried(self):
        write = MagicMock(side_effect=RuntimeError('boom'))
        with pytest.raises(RuntimeError):
            write_with_fresh_id('proj', write, now=MOMENT)
        write.assert_called_once()

    def test_a_refused_project_check_in_a_transaction_is_not_retried(self):
        write = MagicMock(side_effect=_client_error(
            'TransactionCanceledException', [{'Code': 'ConditionalCheckFailed'}, {'Code': 'None'}]))
        with pytest.raises(ClientError):
            write_with_fresh_id('doc', write, put_index=1, now=MOMENT)
        write.assert_called_once()
