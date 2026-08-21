"""Tests for aggregator/handler.py

Tests the core aggregation functions:
- update_counter()
- update_average()
- process_new_feedback()
- record_handler()

The stream consumer used to count only INSERTs, so every aggregate held items
EVER inserted and never came back down — `get_metrics_summary` (aggregates) and
`search_feedback` (scan) then reported different totals for the same window.
Handling REMOVE and MODIFY is the fix, and the classes below pin the three
decisions inside it that a naive implementation gets wrong. The revert map:

  TestTtlExpiryLeavesHistoryAlone
    — the feedback table expires items at 365 days while aggregate rows expire at
      90, so a TTL REMOVE always concerns a date whose row is already gone.
      Deleting the `is_ttl_expiry` skip in `record_handler` fails
      `test_a_ttl_expiry_writes_nothing_at_all`; its sibling
      `test_a_user_delete_of_the_same_item_does_write` is the positive control,
      so the pair cannot both pass by the mock being inert.
      `test_a_remove_with_no_user_identity_is_treated_as_a_user_delete` pins the
      chosen direction for an unreadable identity; inverting that default fails
      it.

  TestADeleteReversesExactlyWhatTheInsertAdded
    — derives both write sets from the handler rather than restating them, so a
      dimension added to the increment path without a matching reverse fails
      `test_the_reversed_dimensions_are_exactly_the_incremented_ones`. Replacing
      the shared `counter_dimensions` with an inverted hand-written twin is the
      mutation this is aimed at.

  TestADecrementCannotCreateOrGoNegative
    — dropping the `ConditionExpression` from `update_counter`'s decrement branch
      fails `test_a_decrement_against_a_missing_row_creates_nothing` (moto really
      does refuse the write, and without the condition the row is created holding
      `-1` with a fresh 90-day TTL) and
      `test_a_repeated_remove_does_not_push_a_counter_below_zero` (Streams are
      at-least-once). Re-raising ConditionalCheckFailedException instead of
      swallowing it fails `test_a_refused_decrement_is_not_an_error`.

  TestAnEditMovesAnItemBetweenBuckets
    — restoring the old `if event_name != 'INSERT': return` for MODIFY fails
      seven of these plus `test_skips_a_modify_missing_an_image`. Rebucketing
      every dimension instead of only the changed ones fails
      `test_dimensions_whose_value_did_not_change_are_not_written` and
      `test_an_edit_touching_no_dimension_writes_nothing`; dropping the
      `urgency == 'high'` guard fails five tests across three classes, including
      `test_urgency_raised_to_high_adds_the_urgent_count`.

Each of those reverts was RUN, not predicted. Two more were run for the same
reason:

  * having the reverse path skip one dimension — the shape an inverted
    hand-written twin of the eight original `update_counter` calls would
    eventually take — fails
    `test_the_reversed_dimensions_are_exactly_the_incremented_ones`;
  * treating an absent `userIdentity` as TTL expiry fails
    `test_a_remove_with_no_user_identity_is_treated_as_a_user_delete` plus both
    tests that delete without one.
"""
import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from unittest.mock import patch, MagicMock
from decimal import Decimal
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import DynamoDBRecord

TTL_IDENTITY = {'principalId': 'dynamodb.amazonaws.com', 'type': 'Service'}


def _to_ddb(item: dict) -> dict:
    """Serialize a plain dict the way a stream image arrives."""
    out = {}
    for key, value in item.items():
        if isinstance(value, bool):
            out[key] = {'BOOL': value}
        elif isinstance(value, (int, float, Decimal)):
            out[key] = {'N': str(value)}
        else:
            out[key] = {'S': str(value)}
    return out


def _record(event_name: str, *, new=None, old=None, user_identity=None) -> DynamoDBRecord:
    """A real Powertools stream record, not a MagicMock.

    A MagicMock answers any attribute, so `record.user_identity` on one would be
    a truthy mock and the TTL branch could never be exercised honestly.
    """
    body: dict = {'eventName': event_name, 'eventSource': 'aws:dynamodb', 'dynamodb': {}}
    if new is not None:
        body['dynamodb']['NewImage'] = _to_ddb(new)
    if old is not None:
        body['dynamodb']['OldImage'] = _to_ddb(old)
    if user_identity is not None:
        body['userIdentity'] = user_identity
    return DynamoDBRecord(body)


def _writes(mock_table) -> list[tuple[str, str, str, int]]:
    """Every write a mocked aggregates table received, as (pk, sk, field, delta).

    Derived from the calls rather than restated, so the assertions below compare
    what the handler DID in one direction against what it did in the other.
    """
    out = []
    for call in mock_table.update_item.call_args_list:
        kwargs = call.kwargs
        key, names, values = kwargs['Key'], kwargs['ExpressionAttributeNames'], kwargs['ExpressionAttributeValues']
        if '#field' in names:
            out.append((key['pk'], key['sk'], names['#field'], values[':inc']))
        else:
            # update_average: `:one` carries the sign of the count movement.
            out.append((key['pk'], key['sk'], 'sum', values[':one']))
    return out


def _dimensions(writes) -> set[tuple[str, str, str]]:
    """The (pk, sk, field) triples written, dropping the direction."""
    return {(pk, sk, field) for pk, sk, field, _ in writes}


@pytest.fixture
def real_aggregates_table():
    """A moto-backed aggregates table, so condition expressions are really evaluated.

    The floor-at-zero and no-resurrection properties are properties of DynamoDB's
    evaluation of the ConditionExpression. A mock cannot refuse a write, so
    against a mock those tests would pass with the condition deleted.
    """
    with mock_aws():
        table = boto3.resource('dynamodb', region_name='us-east-1').create_table(
            TableName='test-aggregates',
            KeySchema=[
                {'AttributeName': 'pk', 'KeyType': 'HASH'},
                {'AttributeName': 'sk', 'KeyType': 'RANGE'},
            ],
            AttributeDefinitions=[
                {'AttributeName': 'pk', 'AttributeType': 'S'},
                {'AttributeName': 'sk', 'AttributeType': 'S'},
            ],
            BillingMode='PAY_PER_REQUEST',
        )
        with patch('aggregator.handler.aggregates_table', table):
            yield table


class TestGetMetricType:
    """Tests for get_metric_type() function."""

    def test_returns_source_for_daily_source_pk(self):
        """Returns 'source' for daily_source metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_source#webscraper')
        
        assert result == 'source'

    def test_returns_persona_for_persona_pk(self):
        """Returns 'persona' for persona metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#persona#Happy Customer')
        
        assert result == 'persona'

    def test_returns_none_for_other_pk(self):
        """Returns None for non-indexed metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_total')
        
        assert result is None

    def test_returns_none_for_category_pk(self):
        """Returns None for category metric pk."""
        from aggregator.handler import get_metric_type
        
        result = get_metric_type('METRIC#daily_category#product_quality')
        
        assert result is None


class TestUpdateCounter:
    """Tests for update_counter() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_one(self, mock_table):
        """Increments counter field by 1 by default."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count')
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_total', 'sk': '2025-01-15'}
        assert ':inc' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_increments_counter_by_custom_amount(self, mock_table):
        """Increments counter by specified amount."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=5)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['ExpressionAttributeValues'][':inc'] == 5

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the counter item."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_total', '2025-01-15', 'count', ttl_days=30)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']
        # TTL should be approximately 30 days from now
        ttl_value = call_kwargs['ExpressionAttributeValues'][':ttl']
        assert isinstance(ttl_value, int)

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_source_pk(self, mock_table):
        """Includes metric_type for source metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#daily_source#webscraper', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'source'

    @patch('aggregator.handler.aggregates_table')
    def test_includes_metric_type_for_persona_pk(self, mock_table):
        """Includes metric_type for persona metrics (for GSI)."""
        from aggregator.handler import update_counter
        
        update_counter('METRIC#persona#Happy Customer', '2025-01-15', 'count')
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':metric_type' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':metric_type'] == 'persona'


class TestUpdateAverage:
    """Tests for update_average() function."""

    @patch('aggregator.handler.aggregates_table')
    def test_updates_sum_and_count(self, mock_table):
        """Updates sum and count for running average calculation."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        
        mock_table.update_item.assert_called_once()
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert call_kwargs['Key'] == {'pk': 'METRIC#daily_sentiment_avg', 'sk': '2025-01-15'}
        assert ':val' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':val'] == Decimal('0.85')
        assert ':one' in call_kwargs['ExpressionAttributeValues']
        assert call_kwargs['ExpressionAttributeValues'][':one'] == 1

    @patch('aggregator.handler.aggregates_table')
    def test_sets_ttl(self, mock_table):
        """Sets TTL on the average item."""
        from aggregator.handler import update_average
        
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'), ttl_days=60)
        
        call_kwargs = mock_table.update_item.call_args.kwargs
        assert ':ttl' in call_kwargs['ExpressionAttributeValues']


class TestProcessNewFeedback:
    """Tests for process_new_feedback() function."""

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_total(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily total counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        # Check daily total was updated
        calls = mock_counter.call_args_list
        daily_total_call = [c for c in calls if c.args[0] == 'METRIC#daily_total']
        assert len(daily_total_call) == 1
        assert daily_total_call[0].args[1] == '2025-01-15'

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_source(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily source counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        source_call = [c for c in calls if 'daily_source#webscraper' in c.args[0]]
        assert len(source_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_category(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily category counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        category_call = [c for c in calls if 'daily_category#product_quality' in c.args[0]]
        assert len(category_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_daily_sentiment(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates daily sentiment counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        sentiment_call = [c for c in calls if 'daily_sentiment#positive' in c.args[0]]
        assert len(sentiment_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_sentiment_average(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates sentiment score average."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        mock_avg.assert_called_once()
        call_args = mock_avg.call_args
        assert call_args.args[0] == 'METRIC#daily_sentiment_avg'
        assert call_args.args[1] == '2025-01-15'
        assert call_args.args[2] == Decimal('0.85')

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_urgent_counter_for_high_urgency(self, mock_counter, mock_avg, sample_urgent_feedback_item):
        """Updates urgent counter when urgency is high."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_urgent_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_urgent_counter_for_low_urgency(self, mock_counter, mock_avg, sample_feedback_item):
        """Does not update urgent counter when urgency is low."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        urgent_call = [c for c in calls if c.args[0] == 'METRIC#urgent']
        assert len(urgent_call) == 0

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_persona_counter(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates persona counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        persona_call = [c for c in calls if 'persona#Happy Customer' in c.args[0]]
        assert len(persona_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_updates_category_sentiment_combo(self, mock_counter, mock_avg, sample_feedback_item):
        """Updates category + sentiment combination counter."""
        from aggregator.handler import process_new_feedback
        
        process_new_feedback(sample_feedback_item)
        
        calls = mock_counter.call_args_list
        combo_call = [c for c in calls if 'category_sentiment#product_quality#positive' in c.args[0]]
        assert len(combo_call) == 1

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_uses_current_date_when_date_missing(self, mock_counter, mock_avg):
        """Uses current date when date field is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_date = {
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
        }
        
        process_new_feedback(item_without_date)
        
        # Should still call update_counter with some date
        assert mock_counter.called

    @patch('aggregator.handler.update_average')
    @patch('aggregator.handler.update_counter')
    def test_skips_sentiment_average_when_score_missing(self, mock_counter, mock_avg):
        """Skips sentiment average update when score is missing."""
        from aggregator.handler import process_new_feedback
        
        item_without_score = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'category': 'other',
            'sentiment_label': 'neutral',
            'sentiment_score': None,
        }
        
        process_new_feedback(item_without_score)
        
        mock_avg.assert_not_called()


class TestRecordHandler:
    """Tests for record_handler() function."""

    @patch('aggregator.handler.process_new_feedback')
    def test_processes_insert_event(self, mock_process, sample_feedback_item):
        """Processes INSERT events from DynamoDB stream."""
        from aggregator.handler import record_handler
        
        # Create mock DynamoDB record
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'pk': {'S': 'SOURCE#webscraper'},
            'sk': {'S': 'FEEDBACK#abc123'},
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'category': {'S': 'product_quality'},
            'sentiment_label': {'S': 'positive'},
            'sentiment_score': {'N': '0.85'},
        }
        
        result = record_handler(record)
        
        assert result['status'] == 'success'
        mock_process.assert_called_once()

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_does_not_treat_a_modify_as_an_insert(self, mock_process, mock_table):
        """A MODIFY is rebucketed, never counted as a fresh arrival."""
        from aggregator.handler import record_handler

        record = _record('MODIFY', old={'date': '2025-01-15'}, new={'date': '2025-01-15'})

        record_handler(record)

        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_a_modify_missing_an_image(self, mock_process):
        """Cannot rebucket without both images, so writes nothing."""
        from aggregator.handler import record_handler

        result = record_handler(_record('MODIFY', new={'date': '2025-01-15'}))

        assert result['status'] == 'skipped'
        assert result['reason'] == 'incomplete images'
        mock_process.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_does_not_treat_a_remove_as_an_insert(self, mock_process, mock_table):
        """A REMOVE reverses, never counts up."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old={'date': '2025-01-15'}))

        mock_process.assert_not_called()

    @patch('aggregator.handler.process_deleted_feedback')
    def test_skips_a_remove_with_no_old_image(self, mock_process):
        """Without an old image there is nothing to reverse."""
        from aggregator.handler import record_handler

        result = record_handler(_record('REMOVE'))

        assert result['status'] == 'skipped'
        assert result['reason'] == 'no old image'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_skips_when_no_new_image(self, mock_process):
        """Skips when new_image is missing."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = None
        
        result = record_handler(record)
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'no new image'
        mock_process.assert_not_called()

    @patch('aggregator.handler.process_new_feedback')
    def test_converts_dynamodb_format_to_dict(self, mock_process):
        """Converts DynamoDB format to regular dict."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'sentiment_score': {'N': '0.85'},
        }
        
        record_handler(record)
        
        # Check the item passed to process_new_feedback
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'
        assert item['sentiment_score'] == Decimal('0.85')

    @patch('aggregator.handler.process_new_feedback')
    def test_handles_already_deserialized_format(self, mock_process):
        """Handles already deserialized DynamoDB format."""
        from aggregator.handler import record_handler
        
        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb = MagicMock()
        # Powertools may already deserialize the data
        record.dynamodb.new_image = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'sentiment_score': Decimal('0.85'),
        }
        
        record_handler(record)
        
        call_args = mock_process.call_args
        item = call_args.args[0]
        assert item['date'] == '2025-01-15'
        assert item['source_platform'] == 'webscraper'


class TestTtlExpiryLeavesHistoryAlone:
    """A REMOVE from the TTL reaper must not change any aggregate.

    Feedback items live 365 days; the aggregate row for the date they arrived on
    lives 90. So the TTL REMOVE for the feedback of date D arrives around D+365,
    when the row for D is long gone — and an unconditional decrement would
    RECREATE it holding a negative count with a fresh 90-day TTL. The item really
    did arrive on D; garbage-collecting it later is not a correction.
    """

    @patch('aggregator.handler.aggregates_table')
    def test_a_ttl_expiry_writes_nothing_at_all(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        result = record_handler(
            _record('REMOVE', old=sample_feedback_item, user_identity=TTL_IDENTITY)
        )

        assert result == {"status": "skipped", "reason": "ttl expiry"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_a_user_delete_of_the_same_item_does_write(self, mock_table, sample_feedback_item):
        """Positive control for the test above: the mock is not inert."""
        from aggregator.handler import record_handler

        result = record_handler(_record('REMOVE', old=sample_feedback_item))

        assert result == {"status": "success"}
        assert mock_table.update_item.call_count > 0

    @patch('aggregator.handler.aggregates_table')
    def test_a_remove_with_no_user_identity_is_treated_as_a_user_delete(
        self, mock_table, sample_feedback_item
    ):
        """An absent identity fails TOWARD correcting the count.

        A real user delete is the case this fix exists for, and misreading one as
        TTL expiry leaves the aggregate permanently overstated. The opposite
        misreading costs one decrement, and the ConditionExpression keeps even
        that from corrupting a row.
        """
        from aggregator.handler import record_handler

        record = _record('REMOVE', old=sample_feedback_item)
        assert 'userIdentity' not in record.raw_event

        assert record_handler(record) == {"status": "success"}
        assert mock_table.update_item.call_count > 0

    @patch('aggregator.handler.aggregates_table')
    def test_a_non_service_identity_is_a_user_delete(self, mock_table, sample_feedback_item):
        """Only `dynamodb.amazonaws.com` + `Service` means the reaper."""
        from aggregator.handler import record_handler

        record = _record(
            'REMOVE', old=sample_feedback_item,
            user_identity={'principalId': 'AIDAEXAMPLE', 'type': 'AssumedRole'},
        )

        assert record_handler(record) == {"status": "success"}
        assert mock_table.update_item.call_count > 0


class TestADeleteReversesExactlyWhatTheInsertAdded:
    """Every dimension the insert incremented, the delete decrements.

    Both sets are derived from the handler, never restated here, so a dimension
    added to one path only fails this rather than passing a stale list.
    """

    @patch('aggregator.handler.aggregates_table')
    def test_the_reversed_dimensions_are_exactly_the_incremented_ones(
        self, mock_table, sample_urgent_feedback_item
    ):
        from aggregator.handler import record_handler

        record_handler(_record('INSERT', new=sample_urgent_feedback_item))
        inserted = _writes(mock_table)
        mock_table.reset_mock()

        record_handler(_record('REMOVE', old=sample_urgent_feedback_item))
        removed = _writes(mock_table)

        assert _dimensions(inserted) == _dimensions(removed)
        assert all(delta == 1 for *_, delta in inserted)
        assert all(delta == -1 for *_, delta in removed)

    @patch('aggregator.handler.aggregates_table')
    def test_the_sentiment_average_is_reversed_too(self, mock_table, sample_feedback_item):
        """`sum` moves back by the same score, and `count` back by one."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item))

        avg = [c.kwargs for c in mock_table.update_item.call_args_list
               if c.kwargs['Key']['pk'] == 'METRIC#daily_sentiment_avg']
        assert len(avg) == 1
        assert avg[0]['ExpressionAttributeValues'][':val'] == Decimal('-0.85')
        assert avg[0]['ExpressionAttributeValues'][':one'] == -1

    @patch('aggregator.handler.aggregates_table')
    def test_a_non_urgent_delete_does_not_touch_the_urgent_row(
        self, mock_table, sample_feedback_item
    ):
        """No urgent row was ever written for it, so none may be decremented."""
        from aggregator.handler import record_handler

        record_handler(_record('REMOVE', old=sample_feedback_item))

        assert not [c for c in mock_table.update_item.call_args_list
                    if c.kwargs['Key']['pk'] == 'METRIC#urgent']


class TestADecrementCannotCreateOrGoNegative:
    """The guard on the decrement, evaluated by a real DynamoDB implementation."""

    def test_a_decrement_against_a_missing_row_creates_nothing(self, real_aggregates_table):
        """An aggregate that has already expired has nothing to correct.

        Without the ConditionExpression, `if_not_exists(#field, :zero) + :inc`
        creates the row holding `-1` and stamps a fresh 90-day TTL on it — a
        negative count served by any window query reaching that far back.
        """
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        assert real_aggregates_table.scan()['Items'] == []

    def test_a_repeated_remove_does_not_push_a_counter_below_zero(self, real_aggregates_table):
        """Streams deliver at-least-once, so the same REMOVE can arrive twice."""
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=1)
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)
        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        items = real_aggregates_table.scan()['Items']
        assert [i['count'] for i in items] == [Decimal(0)]

    def test_an_average_reversal_against_a_missing_row_creates_nothing(self, real_aggregates_table):
        from aggregator.handler import update_average

        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)

        assert real_aggregates_table.scan()['Items'] == []

    def test_an_average_count_does_not_go_below_zero(self, real_aggregates_table):
        from aggregator.handler import update_average

        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'))
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)
        update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.85'), sign=-1)

        item = real_aggregates_table.scan()['Items'][0]
        assert item['count'] == Decimal(0)
        assert item['sum'] == Decimal(0)

    @patch('aggregator.handler.aggregates_table')
    def test_a_refused_decrement_is_not_an_error(self, mock_table):
        """ConditionalCheckFailedException is the expected benign outcome."""
        from aggregator.handler import update_counter

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}},
            'UpdateItem',
        )

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

    @patch('aggregator.handler.aggregates_table')
    def test_any_other_dynamodb_error_still_raises(self, mock_table):
        """Only the condition failure is benign; a throttle must reach the batch processor."""
        from aggregator.handler import update_counter

        mock_table.update_item.side_effect = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
            'UpdateItem',
        )

        with pytest.raises(ClientError):
            update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

    @patch('aggregator.handler.aggregates_table')
    def test_an_increment_carries_no_condition(self, mock_table):
        """A date's FIRST item has no row yet, so the increment must be free to create one."""
        from aggregator.handler import update_counter

        update_counter('METRIC#daily_total', '2025-01-15', 'count')

        assert 'ConditionExpression' not in mock_table.update_item.call_args.kwargs


class TestAnEditMovesAnItemBetweenBuckets:
    """MODIFY comes from `PUT /data-explorer/feedback`, which edits in place."""

    @patch('aggregator.handler.aggregates_table')
    def test_a_changed_category_moves_the_count(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'category': 'billing'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        writes = _writes(mock_table)
        assert ('METRIC#daily_category#product_quality', '2025-01-15', 'count', -1) in writes
        assert ('METRIC#daily_category#billing', '2025-01-15', 'count', 1) in writes

    @patch('aggregator.handler.aggregates_table')
    def test_dimensions_whose_value_did_not_change_are_not_written(
        self, mock_table, sample_feedback_item
    ):
        """An unrelated edit writes nothing; a category edit touches only category rows.

        Rebucketing everything would net to zero but refresh each row's 90-day
        TTL, and a decrement refused against a row at zero would leave its paired
        increment un-cancelled.
        """
        from aggregator.handler import record_handler

        record_handler(_record('MODIFY', old=sample_feedback_item,
                               new={**sample_feedback_item, 'category': 'billing'}))
        touched = {pk for pk, _, _, _ in _writes(mock_table)}

        assert touched == {
            'METRIC#daily_category#product_quality',
            'METRIC#daily_category#billing',
            'METRIC#category_sentiment#product_quality#positive',
            'METRIC#category_sentiment#billing#positive',
        }

    @patch('aggregator.handler.aggregates_table')
    def test_an_edit_touching_no_dimension_writes_nothing(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'problem_summary': 'reworded by a human'}

        result = record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert result == {"status": "success"}
        mock_table.update_item.assert_not_called()

    @patch('aggregator.handler.aggregates_table')
    def test_urgency_downgraded_from_high_removes_the_urgent_count(
        self, mock_table, sample_urgent_feedback_item
    ):
        from aggregator.handler import record_handler

        edited = {**sample_urgent_feedback_item, 'urgency': 'low'}

        record_handler(_record('MODIFY', old=sample_urgent_feedback_item, new=edited))

        writes = _writes(mock_table)
        assert ('METRIC#urgent', '2025-01-15', 'count', -1) in writes
        assert not [w for w in writes if w[0] == 'METRIC#urgent' and w[3] == 1]

    @patch('aggregator.handler.aggregates_table')
    def test_a_non_urgent_edit_never_writes_an_urgent_row(self, mock_table, sample_feedback_item):
        """Neither side is high, so `METRIC#urgent` must not appear in either direction."""
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'urgency': 'medium'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert not [w for w in _writes(mock_table) if w[0] == 'METRIC#urgent']

    @patch('aggregator.handler.aggregates_table')
    def test_urgency_raised_to_high_adds_the_urgent_count(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'urgency': 'high'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        assert ('METRIC#urgent', '2025-01-15', 'count', 1) in _writes(mock_table)

    @patch('aggregator.handler.aggregates_table')
    def test_an_edited_date_moves_every_counter_to_the_new_day(
        self, mock_table, sample_feedback_item
    ):
        """`date` is the one field whose edit rebuckets all dimensions at once."""
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'date': '2025-02-01'}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        writes = _writes(mock_table)
        assert {sk for _, sk, _, delta in writes if delta == -1} == {'2025-01-15'}
        assert {sk for _, sk, _, delta in writes if delta == 1} == {'2025-02-01'}

    @patch('aggregator.handler.aggregates_table')
    def test_an_edited_sentiment_score_moves_the_average(self, mock_table, sample_feedback_item):
        from aggregator.handler import record_handler

        edited = {**sample_feedback_item, 'sentiment_score': Decimal('0.10')}

        record_handler(_record('MODIFY', old=sample_feedback_item, new=edited))

        avg = [c.kwargs['ExpressionAttributeValues'] for c in mock_table.update_item.call_args_list
               if c.kwargs['Key']['pk'] == 'METRIC#daily_sentiment_avg']
        assert [(v[':val'], v[':one']) for v in avg] == [
            (Decimal('-0.85'), -1), (Decimal('0.10'), 1),
        ]


class TestCounterDimensions:
    """The single description of the dimensions both directions are built from."""

    def test_an_urgent_item_adds_the_urgent_dimension(
        self, sample_feedback_item, sample_urgent_feedback_item
    ):
        from aggregator.handler import counter_dimensions

        plain = set(counter_dimensions(sample_feedback_item))
        urgent = set(counter_dimensions(sample_urgent_feedback_item))

        assert ('METRIC#urgent', 'count') in urgent
        assert ('METRIC#urgent', 'count') not in plain

    def test_a_missing_dimension_falls_back_to_the_same_default_both_ways(self):
        """Increment and decrement must derive identical pks for a sparse item."""
        from aggregator.handler import counter_dimensions

        assert counter_dimensions({}) == counter_dimensions({'date': '2025-01-15'})
        assert ('METRIC#daily_source#unknown', 'count') in counter_dimensions({})
