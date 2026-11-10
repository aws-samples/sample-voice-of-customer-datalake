"""shared.feature_boards_limits.refund_support: a best-effort refund never hides the write's own error."""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from shared.feature_boards_limits import refund_support

KEY = {'pk': 'RATE#brd_1#abc#2026-11-01', 'sk': 'COUNT'}


def test_no_key_refunds_nothing():
    table = MagicMock()
    refund_support(table, None)
    table.update_item.assert_not_called()


def test_the_charged_counter_goes_down_by_one_and_never_below_zero():
    table = MagicMock()
    refund_support(table, KEY)
    kwargs = table.update_item.call_args.kwargs
    assert kwargs['Key'] == KEY
    assert (kwargs['UpdateExpression'], kwargs['ConditionExpression']) == ('ADD #c :minus', '#c > :zero')
    assert kwargs['ExpressionAttributeValues'] == {':minus': -1, ':zero': 0}


def test_a_counter_already_at_zero_is_swallowed_without_a_warning():
    table = MagicMock()
    table.update_item.side_effect = ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'at zero'}}, 'UpdateItem')
    with patch('shared.feature_boards_limits.logger') as log:
        assert refund_support(table, KEY) is None  # must not raise
    table.update_item.assert_called_once()
    log.warning.assert_not_called()


@pytest.mark.parametrize('error', [
    ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'busy'}}, 'UpdateItem'),
    EndpointConnectionError(endpoint_url='https://dynamodb.example'),
    RuntimeError('anything else'),
])
def test_any_other_failed_refund_is_logged_and_swallowed(error):
    table = MagicMock()
    table.update_item.side_effect = error
    with patch('shared.feature_boards_limits.logger') as log:
        assert refund_support(table, KEY) is None  # must not raise: the caller answers the write's own error
    table.update_item.assert_called_once()
    log.warning.assert_called_once()
    assert log.warning.call_args.kwargs['exc_info'] is error
    assert log.warning.call_args.kwargs['extra'] == {'pk': KEY['pk']}
