"""shared.feature_boards_limits.refund_support: a best-effort refund never hides the write's own error."""
from unittest.mock import MagicMock

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


@pytest.mark.parametrize('error', [
    ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'at zero'}}, 'UpdateItem'),
    ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'busy'}}, 'UpdateItem'),
    EndpointConnectionError(endpoint_url='https://dynamodb.example'),
    RuntimeError('anything else'),
])
def test_a_failed_refund_is_swallowed(error):
    table = MagicMock()
    table.update_item.side_effect = error
    refund_support(table, KEY)  # must not raise: the caller is answering the write's own error
