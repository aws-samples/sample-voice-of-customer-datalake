"""The aggregator lowers the earliest-data watermark on every INSERT.

`METRIC#meta / earliest_date` is what the metrics routes resolve `days=0` (all
time) against. It may only ever move EARLIER, which a conditional update makes
true under concurrency; these tests pin the request, the benign refusal, the
container memo that skips writes it cannot win, and that a real failure
propagates (so the record is retried before any counter moves).
"""
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from aggregator.test.aggregator_fixtures import conditional_check_failure

pytestmark = pytest.mark.real_watermark


def _conditional_failure(stored_date: str | None) -> ClientError:
    if stored_date is None:
        return conditional_check_failure()
    # The wire shape: ALL_OLD on a ClientError is not deserialised by the resource layer.
    return conditional_check_failure({'pk': {'S': 'METRIC#meta'}, 'date': {'S': stored_date}})


@patch('aggregator.handler.aggregates_table')
def test_the_write_is_conditional_on_being_earlier(mock_table):
    from aggregator.handler import lower_earliest_date

    lower_earliest_date('2025-01-15')

    kwargs = mock_table.update_item.call_args.kwargs
    assert kwargs['Key'] == {'pk': 'METRIC#meta', 'sk': 'earliest_date'}
    assert kwargs['ConditionExpression'] == 'attribute_not_exists(#date) OR #date > :date'
    assert kwargs['ExpressionAttributeNames'] == {'#date': 'date'}
    assert kwargs['ExpressionAttributeValues'][':date'] == '2025-01-15'
    assert 'ttl' not in kwargs['UpdateExpression']


@patch('aggregator.handler.aggregates_table')
def test_a_refusal_is_benign_and_teaches_the_stored_date(mock_table):
    from aggregator.handler import lower_earliest_date

    mock_table.update_item.side_effect = _conditional_failure('2024-06-01')
    lower_earliest_date('2025-01-15')  # does not raise

    mock_table.update_item.reset_mock()
    lower_earliest_date('2024-12-31')
    mock_table.update_item.assert_not_called()

    lower_earliest_date('2024-05-01')
    mock_table.update_item.assert_called_once()


@patch('aggregator.handler.aggregates_table')
def test_a_landed_write_is_remembered(mock_table):
    from aggregator.handler import lower_earliest_date

    lower_earliest_date('2025-01-15')
    lower_earliest_date('2025-01-15')
    lower_earliest_date('2025-02-01')

    assert mock_table.update_item.call_count == 1


@patch('aggregator.handler.aggregates_table')
def test_any_other_failure_propagates(mock_table):
    from aggregator.handler import lower_earliest_date

    mock_table.update_item.side_effect = ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}},
        'UpdateItem',
    )
    with pytest.raises(ClientError):
        lower_earliest_date('2025-01-15')


@patch('aggregator.handler.aggregates_table')
def test_a_malformed_date_writes_nothing(mock_table):
    from aggregator.handler import lower_earliest_date

    lower_earliest_date('not-a-date')
    mock_table.update_item.assert_not_called()


@patch('aggregator.handler.process_new_feedback', MagicMock(return_value=True))
@patch('aggregator.handler.lower_earliest_date')
def test_an_insert_lowers_the_watermark_before_the_counters(mock_lower, sample_feedback_item):
    from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

    from aggregator.handler import record_handler

    record = DynamoDBRecord({
        'eventID': 'evt-1',
        'eventName': 'INSERT',
        'dynamodb': {'NewImage': {
            'pk': {'S': sample_feedback_item['pk']},
            'sk': {'S': sample_feedback_item['sk']},
            'date': {'S': sample_feedback_item['date']},
        }},
    })
    record_handler(record)

    mock_lower.assert_called_once_with('2025-01-15')
