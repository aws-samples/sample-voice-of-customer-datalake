"""Mutation-hardening tests for `aggregator/handler.py`, lines 1566-2180.

Every test here exists because a mutant of that range survived test_handler.py and
the earlier slices' suites. What those suites could not see:

* the operator-facing log lines of the arrival, increment, reversal and rebucket
  paths — including the `unknown` / `other` an item missing its source or category
  is logged under, and the counts and days an aged-out rebucket names. The existing
  suites read the table back and never the logger;
* `process_modified_feedback`'s landed TOTAL. Every caller compared it with zero, so
  a total that dropped the decrements or the average (or subtracted it) read the same;
* the tracer wrappers on the three `process_*` entry points, which only a trace shows;
* the container memo's cold-start value: the autouse fixture resets it to None before
  every test, so a module that started with any other value was invisible;
* `_rebucket_average`'s landed count (one or two), its decline line, and which half
  is skipped when it has nothing to do;
* the `M` / `L` / `BOOL` wire types (every fixture image is `S` and `N` only), the
  TTL identity needing BOTH fields, the enum fallback of `_event_name`, and a
  non-string or empty `eventID`;
* `record_handler`'s log lines and the metric VALUE of one per event.

Two survivors were dead code rather than missing tests and were deleted instead: the
`'None'` branch of the new-image keys log (the line is reached only with an image),
and an annotation on a local that Python never evaluates.
"""
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest
from aws_lambda_powertools.utilities.data_classes.dynamo_db_stream_event import (
    DynamoDBRecord,
    DynamoDBRecordEventName,
)

import aggregator.handler as handler
from aggregator.test.aggregator_fixtures import stream_record
from shared.test.fresh_module import fresh_module_copy
from shared.test.instrumentation_fixtures import assert_tracer_wrapped

DAY, NEXT_DAY = '2025-01-15', '2025-01-16'
BILLING = {'date': DAY, 'category': 'billing', 'source_platform': 'webscraper'}
DELIVERY = {**BILLING, 'category': 'delivery'}
ZERO, OLD, NEW = Decimal('0'), Decimal('1'), Decimal('2')  # sentiment scores


def _info_messages(logger: MagicMock) -> list[str]:
    return [entry.args[0] for entry in logger.info.call_args_list]


class TestEachPathLogsWhatItDid:
    @pytest.mark.parametrize(('item', 'line'), [
        (BILLING, 'Updated aggregates for source=webscraper, category=billing'),
        ({'date': DAY}, 'Updated aggregates for source=unknown, category=other'),
    ])
    def test_an_applied_arrival_names_its_source_and_category(self, item, line):
        with patch.object(handler, '_claimed_transaction', return_value=True), \
                patch.object(handler, 'logger') as logger:
            assert handler.apply_arrival_once(item, DAY, 'aggregator#stream#e1') is True

        logger.info.assert_called_once_with(line)

    @pytest.mark.parametrize(('item', 'sign', 'line'), [
        (BILLING, 1, 'Updated aggregates for source=webscraper, category=billing'),
        (BILLING, -1, 'Reversed aggregates for source=webscraper, category=billing'),
        ({'date': DAY}, 1, 'Updated aggregates for source=unknown, category=other'),
        ({'date': DAY}, -1, 'Reversed aggregates for source=unknown, category=other'),
    ])
    def test_the_non_transactional_issuer_names_its_direction(self, item, sign, line):
        with patch.object(handler, 'apply_counter_keys', return_value=(0, {})), \
                patch.object(handler, '_reverse_a_pre_deploy_persona_row', return_value=0), \
                patch.object(handler, 'logger') as logger:
            handler.apply_feedback(item, sign, DAY)

        logger.info.assert_called_once_with(line)

    def test_a_dateless_remove_says_why_it_wrote_nothing(self):
        with patch.object(handler, 'logger') as logger:
            assert handler.process_deleted_feedback({'category': 'billing'}) is False

        logger.warning.assert_called_once_with(
            'REMOVE image carries no `date`; refusing to guess which day to reverse')

    def test_a_dateless_modify_says_why_it_wrote_nothing(self):
        with patch.object(handler, 'logger') as logger:
            assert handler.process_modified_feedback(BILLING, {'category': 'delivery'}) is None

        logger.warning.assert_called_once_with(
            'MODIFY image carries no `date`; refusing to guess which days to rebucket')

    def test_a_rebucket_of_two_aged_out_days_names_both(self):
        with patch.object(handler, '_day_has_aggregates', return_value=False), \
                patch.object(handler, 'logger') as logger:
            assert handler.process_modified_feedback(BILLING, {**DELIVERY, 'date': NEXT_DAY}) == 0

        logger.info.assert_called_once_with(
            f'Skipping rebucket of an aged-out day ({DAY} -> {NEXT_DAY}): '
            'its aggregates have expired and must not be partially recreated')

    @pytest.mark.parametrize(('live', 'skipped'), [
        ({DAY: False, NEXT_DAY: True}, f'Not decrementing 6 counter(s) on the aged-out {DAY}'),
        ({DAY: True, NEXT_DAY: False}, f'Not incrementing 6 counter(s) on the aged-out {NEXT_DAY}'),
    ])
    def test_the_dead_side_of_a_cross_day_edit_names_its_count_and_day(self, live, skipped):
        # A date edit moves every one of the item's six counters to the other day.
        with patch.object(handler, '_day_has_aggregates', side_effect=live.get), \
                patch.object(handler, 'apply_counter_keys', return_value=(0, {})), \
                patch.object(handler, 'logger') as logger:
            handler.process_modified_feedback({'date': DAY, 'category': 'billing'},
                                              {'date': NEXT_DAY, 'category': 'billing'})

        assert skipped in _info_messages(logger)


class TestARebucketReportsEveryWriteThatLanded:
    def test_an_edit_touching_no_dimension_lands_nothing_and_reads_nothing(self):
        with patch.object(handler, '_day_has_aggregates') as day:
            assert handler.process_modified_feedback(
                BILLING, {**BILLING, 'problem_summary': 'edited'}) == 0

        day.assert_not_called()
    def test_the_total_is_decrements_plus_increments_plus_the_average(self):
        old, new = {**BILLING, 'sentiment_score': 1}, {**DELIVERY, 'sentiment_score': 2}
        with patch.object(handler, '_day_has_aggregates', return_value=True), \
                patch.object(handler, 'apply_counter_keys', side_effect=[(2, {}), (3, {})]) as counters, \
                patch.object(handler, '_reverse_a_pre_deploy_persona_row', return_value=0), \
                patch.object(handler, '_rebucket_average', return_value=5) as average, \
                patch.object(handler, 'logger') as logger:
            assert handler.process_modified_feedback(old, new) == 10

        assert [entry.args[1] for entry in counters.call_args_list] == [-1, 1]
        average.assert_called_once_with(DAY, 1, True, DAY, 2, True)
        assert _info_messages(logger)[-1] == (
            'Rebucketed aggregates: 2 decrement(s), 2 increment(s), 10 landed')

    def test_a_dead_old_day_contributes_no_decrements(self):
        live = {DAY: False, NEXT_DAY: True}
        with patch.object(handler, '_day_has_aggregates', side_effect=live.get), \
                patch.object(handler, 'apply_counter_keys', return_value=(3, {})) as counters, \
                patch.object(handler, '_rebucket_average', return_value=0):
            assert handler.process_modified_feedback(
                {'date': DAY, 'category': 'billing'},
                {'date': NEXT_DAY, 'category': 'billing'},
            ) == 3

        assert [entry.args[1] for entry in counters.call_args_list] == [1]

    def test_an_unmoved_average_contributes_nothing(self):
        with patch.object(handler, '_day_has_aggregates', return_value=True), \
                patch.object(handler, 'apply_counter_keys', side_effect=[(2, {}), (3, {})]), \
                patch.object(handler, '_reverse_a_pre_deploy_persona_row', return_value=0), \
                patch.object(handler, '_rebucket_average') as average:
            assert handler.process_modified_feedback(BILLING, DELIVERY) == 5

        average.assert_not_called()

    def test_a_compatibility_write_is_logged_and_not_counted(self):
        with patch.object(handler, '_day_has_aggregates', return_value=True), \
                patch.object(handler, 'apply_counter_keys', side_effect=[(1, {}), (1, {})]), \
                patch.object(handler, '_reverse_a_pre_deploy_persona_row', return_value=2), \
                patch.object(handler, 'logger') as logger:
            assert handler.process_modified_feedback(BILLING, DELIVERY) == 2

        assert _info_messages(logger) == [
            'Also brought down 2 pre-deploy persona row(s) for this edit; '
            'not counted as aggregates the edit itself moved',
            'Rebucketed aggregates: 2 decrement(s), 2 increment(s), 2 landed',
        ]


class TestTheEntryPointsAreTraced:
    @pytest.mark.parametrize('name', [
        'process_new_feedback', 'process_deleted_feedback', 'process_modified_feedback'])
    def test_each_is_the_tracer_wrapper(self, name):
        assert_tracer_wrapped(handler, name)


class TestTheWatermarkMemoStartsEmpty:
    def test_a_cold_container_knows_no_stored_date(self):
        fresh = fresh_module_copy('aggregator_handler_fresh_copy', Path(handler.__file__))

        assert fresh._known_earliest_date is None


class TestTheAverageRebucketCountsBothHalves:
    """`_rebucket_average`'s return, which only the rebucket total spends."""

    @pytest.mark.parametrize(('outcomes', 'landed'), [
        ([True, True], 2), ([True, False], 1), ([False, True], 1)])
    def test_a_cross_day_move_counts_each_landed_half(self, outcomes, landed):
        with patch.object(handler, 'update_average', side_effect=outcomes) as average:
            assert handler._rebucket_average(DAY, OLD, True, NEXT_DAY, NEW, True) == landed

        assert average.call_args_list == [
            call(handler.SENTIMENT_AVG_PK, DAY, OLD, sign=-1),
            call(handler.SENTIMENT_AVG_PK, NEXT_DAY, NEW, sign=1)]

    @pytest.mark.parametrize(('old_score', 'old_live', 'new_score', 'new_live', 'writes'), [
        (ZERO, True, NEW, True, [call(handler.SENTIMENT_AVG_PK, DAY, NEW, sign=1)]),
        (OLD, False, NEW, True, [call(handler.SENTIMENT_AVG_PK, DAY, NEW, sign=1)]),
        (OLD, True, ZERO, True, [call(handler.SENTIMENT_AVG_PK, DAY, OLD, sign=-1)]),
        (OLD, True, NEW, False, [call(handler.SENTIMENT_AVG_PK, DAY, OLD, sign=-1)]),
    ])
    def test_a_half_with_nothing_to_do_is_not_attempted_or_counted(
            self, old_score, old_live, new_score, new_live, writes):
        with patch.object(handler, 'update_average', return_value=True) as average:
            assert handler._rebucket_average(DAY, old_score, old_live, DAY, new_score, new_live) == 1

        assert average.call_args_list == writes

    def test_a_refused_same_row_reversal_declines_and_says_why(self):
        with patch.object(handler, 'update_average', return_value=False) as average, \
                patch.object(handler, 'logger') as logger, \
                patch.object(handler, 'metrics') as metrics:
            assert handler._rebucket_average(DAY, OLD, True, DAY, NEW, True) == 0

        average.assert_called_once_with(handler.SENTIMENT_AVG_PK, DAY, OLD, sign=-1)
        logger.info.assert_called_once_with(
            f'Declined re-application of the average on {handler.SENTIMENT_AVG_PK}/{DAY}: '
            f'its reversal on {DAY} was refused, so the row is either at zero or expired, '
            'and applying the new score alone would leave it claiming an item no present '
            'feedback justifies')
        metrics.add_metric.assert_called_once_with(
            name=handler.DECLINED_METRIC, unit='Count', value=1)


class TestEveryWireTypeIsDeserialized:
    def test_each_raw_type_unwraps_to_its_value(self):
        image = {'s': {'S': 'text'}, 'n': {'N': '1.5'}, 'm': {'M': {'k': 'v'}},
                 'l': {'L': ['a']}, 'b': {'BOOL': False}, 'plain': 7}

        assert handler.deserialize_image(image) == {
            's': 'text', 'n': Decimal('1.5'), 'm': {'k': 'v'}, 'l': ['a'], 'b': False, 'plain': 7}

    def test_an_unknown_wire_type_is_dropped(self):
        assert handler.deserialize_image({'x': {'NULL': True}}) == {}


class TestTheRecordIsReadFromTheEvent:
    @pytest.mark.parametrize(('identity', 'expiry'), [
        ({'principalId': 'dynamodb.amazonaws.com', 'type': 'Service'}, True),
        ({'principalId': 'dynamodb.amazonaws.com', 'type': 'User'}, False),
        ({'principalId': 'someone', 'type': 'Service'}, False),
    ])
    def test_ttl_expiry_needs_both_the_principal_and_the_type(self, identity, expiry):
        assert handler.is_ttl_expiry(stream_record('REMOVE', old=BILLING, user_identity=identity)) is expiry

    def test_a_record_without_a_raw_event_falls_back_to_the_enum_name(self):
        record = MagicMock(raw_event=None, event_name=DynamoDBRecordEventName.MODIFY)

        assert handler._event_name(record) == 'MODIFY'

    @pytest.mark.parametrize(('event_id', 'key'), [
        ('e-1', 'aggregator#stream#e-1'), ('', None), (123, None)])
    def test_only_a_non_empty_string_id_is_a_dedupe_key(self, event_id, key):
        record = DynamoDBRecord({'eventName': 'INSERT', 'eventID': event_id, 'dynamodb': {}})

        assert handler._dedupe_key(record) == key


@contextmanager
def _observed() -> Iterator[tuple[MagicMock, MagicMock]]:
    with patch.object(handler, 'logger') as logger, patch.object(handler, 'metrics') as metrics:
        yield logger, metrics


class TestTheRecordHandlerSaysWhatItDid:
    def test_an_unrecognized_event_is_named_twice(self):
        record = DynamoDBRecord({'eventName': 'TRUNCATE', 'dynamodb': {}})
        with _observed() as (logger, _):
            handler.record_handler(record)

        assert _info_messages(logger) == [
            'Processing record: event_name=TRUNCATE', 'Skipping unrecognized event: TRUNCATE']

    def test_a_ttl_remove_says_history_is_kept(self):
        record = stream_record('REMOVE', old=BILLING, user_identity={
            'principalId': 'dynamodb.amazonaws.com', 'type': 'Service'})
        with _observed() as (logger, _):
            handler.record_handler(record)

        assert _info_messages(logger)[-1] == (
            'Skipping TTL-driven REMOVE: aggregates keep the historical count')

    @pytest.mark.parametrize(('record', 'warning'), [
        (stream_record('REMOVE'), 'No old_image in REMOVE record'),
        (stream_record('MODIFY', new=BILLING), 'MODIFY record is missing an image; cannot rebucket'),
        (stream_record('INSERT'), 'No new_image in record'),
    ])
    def test_a_missing_image_is_a_named_warning(self, record, warning):
        with _observed() as (logger, _):
            handler.record_handler(record)

        logger.warning.assert_called_once_with(warning)

    def test_a_user_delete_names_its_item_and_counts_one_reversal(self):
        with _observed() as (logger, metrics), \
                patch.object(handler, 'process_deleted_feedback', return_value=True):
            assert handler.record_handler(stream_record('REMOVE', old=BILLING)) == {'status': 'success'}

        assert _info_messages(logger)[-1] == 'Reversing feedback: date=2025-01-15, source=webscraper'
        metrics.add_metric.assert_called_once_with(name=handler.REVERSED_METRIC, unit='Count', value=1)

    def test_an_insert_names_its_item_and_counts_one_update(self):
        with _observed() as (logger, metrics), \
                patch.object(handler, 'process_new_feedback', return_value=True):
            assert handler.record_handler(stream_record('INSERT', new=BILLING)) == {'status': 'success'}

        assert _info_messages(logger)[1:] == [
            "new_image keys: ['date', 'category', 'source_platform']",
            'Processing feedback: date=2025-01-15, source=webscraper',
        ]
        metrics.add_metric.assert_called_once_with(name=handler.UPDATED_METRIC, unit='Count', value=1)

    def test_a_rebucket_that_landed_counts_one_rebucket(self):
        with _observed() as (_, metrics), \
                patch.object(handler, 'process_modified_feedback', return_value=3):
            assert handler.record_handler(
                stream_record('MODIFY', old=BILLING, new=DELIVERY)) == {'status': 'success'}

        metrics.add_metric.assert_called_once_with(name=handler.REBUCKETED_METRIC, unit='Count', value=1)
