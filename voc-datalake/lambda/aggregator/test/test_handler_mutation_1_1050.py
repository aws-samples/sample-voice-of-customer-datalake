"""Mutation-hardening tests for `aggregator/handler.py`, lines 1-1050.

Every test here exists because a mutant of that range survived the suite in
test_handler.py: each one pins a literal value that suite only ever read back
through the module's own constants, or an import-time statement that suite
patches away before it can be observed. Expected values are LITERAL on purpose —
a test that re-derives its expectation from the production constant agrees with
whatever the constant says, which is exactly what let these mutants live.

What is pinned, and why it is real:

* the module-level bindings read at IMPORT — `aggregates_table` and the dedupe
  table name — are observed by executing a fresh copy of the module under a
  controlled environment, because every other test patches `aggregates_table`
  and so could never notice it being `None`;
* the CloudWatch metric names are the strings docs/processing-pipeline.md tells an
  operator to alarm on, so a renamed metric is a documentation defect as much as a
  code one. Pinned twice: as literals, and against the doc table;
* `_TRANSIENT_READ_ERRORS` is the allowlist that decides whether an unreadable day
  is logged as a blip or as a misconfiguration; each member is exercised by name;
* the arrival transaction's retry budget is three attempts with two half-jittered
  waits of 25-50 ms and 50-100 ms — numbers the module docstring states and
  `docs/processing-pipeline.md` repeats;
* a counter's defaults for an item missing a dimension are the bucket names the
  metrics reader groups by, and the refusal/decline metrics are emitted with the
  unit CloudWatch expects;
* the request TypedDicts' key contract: the refusal half (`ConditionExpression`,
  `ReturnValuesOnConditionCheckFailure`) is OPTIONAL and the four `update_item`
  arguments are REQUIRED. `total=False` is a static annotation, so the only place
  a test can see it is the classes' own `__optional_keys__`/`__required_keys__` —
  and that contract is what lets `_counter_request` return an increment with no
  condition at all while pyright still checks the decrement's two extra keys.
"""
import importlib.util
import re
from decimal import Decimal
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

# lambda/aggregator/test/<this file> → voc-datalake → repository root, where docs/ lives.
_REPO_ROOT = Path(__file__).resolve().parents[4]
_DOCS = _REPO_ROOT / 'docs' / 'processing-pipeline.md'


def _load_fresh_handler():
    """Execute `aggregator/handler.py` into a NEW module object.

    The installed `aggregator.handler` has already run its import-time statements,
    under whatever environment pytest started with, and every test patches its
    `aggregates_table`. Re-executing the source under a different name is the only
    way to observe what those statements bind without disturbing the installed
    module or the patches other tests hold on it.
    """
    import aggregator.handler as installed

    spec = importlib.util.spec_from_file_location('aggregator_handler_fresh', installed.__file__)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load a fresh copy of {installed.__file__}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestTheImportTimeBindings:
    def test_the_aggregates_table_is_the_one_the_environment_names(self, monkeypatch):
        monkeypatch.setenv('AGGREGATES_TABLE', 'aggregates-under-import')

        fresh = _load_fresh_handler()

        assert fresh.AGGREGATES_TABLE == 'aggregates-under-import'
        assert fresh.aggregates_table.name == 'aggregates-under-import'

    def test_the_dedupe_table_name_is_read_from_the_environment(self, monkeypatch):
        monkeypatch.setenv('IDEMPOTENCY_TABLE', 'dedupe-under-import')

        with patch('shared.logging.logger.warning') as warned:
            fresh = _load_fresh_handler()

        assert fresh.IDEMPOTENCY_TABLE == 'dedupe-under-import'
        warned.assert_not_called()

    def test_an_unconfigured_dedupe_table_is_empty_and_warned_about(self, monkeypatch):
        """Empty, not None: callers test it for truth, and the warning is the only
        thing that says the redelivery protection is off."""
        monkeypatch.delenv('IDEMPOTENCY_TABLE', raising=False)

        with patch('shared.logging.logger.warning') as warned:
            fresh = _load_fresh_handler()

        assert fresh.IDEMPOTENCY_TABLE == ''
        assert warned.call_count == 1
        assert 'IDEMPOTENCY_TABLE not configured' in warned.call_args.args[0]


class TestTheMetricNamesAreTheOnesOperatorsAlarmOn:
    EXPECTED: ClassVar[dict[str, str]] = {
        'UPDATED_METRIC': 'AggregatesUpdated',
        'REVERSED_METRIC': 'AggregatesReversed',
        'REBUCKETED_METRIC': 'AggregatesRebucketed',
        'REFUSED_METRIC': 'AggregateWriteRefused',
        'DECLINED_METRIC': 'AggregateWriteDeclined',
        'REPLAYED_METRIC': 'AggregateRecordReplayed',
        'CONFLICTED_METRIC': 'AggregateTransactionConflicted',
    }

    def test_each_metric_constant_spells_its_cloudwatch_name(self):
        from aggregator import handler

        assert {name: getattr(handler, name) for name in self.EXPECTED} == self.EXPECTED

    def test_the_docs_list_exactly_these_metrics(self):
        """docs/processing-pipeline.md has a table of aggregator metrics; a name
        renamed here and not there sends an operator to an empty graph."""
        documented = set(re.findall(r'^\| `(Aggregate[A-Za-z]+)` \|', _DOCS.read_text(), re.MULTILINE))

        assert documented == set(self.EXPECTED.values())


def _refused() -> ClientError:
    """The error DynamoDB raises for a failed ConditionExpression."""
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'gone'}}, 'UpdateItem')


def _throttled() -> ClientError:
    return ClientError(
        {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'UpdateItem',
    )


class TestARefusalAndADeclineAreEachCountedOnce:
    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_a_refused_decrement_adds_one_count_to_the_refused_metric(self, mock_table, mock_metrics):
        from aggregator.handler import update_counter

        mock_table.update_item.side_effect = _refused()

        update_counter('METRIC#daily_total', '2025-01-15', 'count', increment=-1)

        mock_metrics.add_metric.assert_called_once_with(name='AggregateWriteRefused', unit='Count', value=1)

    @patch('aggregator.handler.metrics')
    @patch('aggregator.handler.aggregates_table')
    def test_a_refused_average_reversal_adds_one_count_to_the_refused_metric(self, mock_table, mock_metrics):
        from aggregator.handler import update_average

        mock_table.update_item.side_effect = _refused()

        assert update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'), sign=-1) is False
        mock_metrics.add_metric.assert_called_once_with(name='AggregateWriteRefused', unit='Count', value=1)

    @patch('aggregator.handler.metrics')
    def test_a_declined_write_adds_one_count_to_the_declined_metric(self, mock_metrics):
        from aggregator.handler import _log_decline

        _log_decline('re-application of average', 'METRIC#daily_sentiment_avg', '2025-01-15', 'row at zero')

        mock_metrics.add_metric.assert_called_once_with(name='AggregateWriteDeclined', unit='Count', value=1)


class TestOnlyARefusedConditionalAverageWriteIsSwallowed:
    """The counter has this guard pinned in test_handler.py; the average did not, and
    `or` → `and` on its guard would turn a throttled reversal into a silent "refused"."""

    @patch('aggregator.handler.aggregates_table')
    def test_a_throttled_reversal_is_raised_not_reported_as_refused(self, mock_table):
        from aggregator.handler import update_average

        mock_table.update_item.side_effect = _throttled()

        with pytest.raises(ClientError):
            update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'), sign=-1)

    @patch('aggregator.handler.aggregates_table')
    def test_a_condition_failure_on_an_unconditional_write_is_raised(self, mock_table):
        """An increment carries no condition, so DynamoDB refusing one is not the
        benign outcome and must reach the batch processor."""
        from aggregator.handler import update_average

        mock_table.update_item.side_effect = _refused()

        with pytest.raises(ClientError):
            update_average('METRIC#daily_sentiment_avg', '2025-01-15', Decimal('0.5'))


class TestEveryTransientReadErrorIsABlipAndNothingElseIs:
    """`_day_has_aggregates` fails open either way; the allowlist decides the log level."""

    DAY = '2025-01-15'
    TRANSIENT = (
        'ProvisionedThroughputExceededException',
        'ThrottlingException',
        'ThrottlingException.TooManyRequests',
        'RequestLimitExceeded',
        'InternalServerError',
        'ServiceUnavailable',
        'RequestTimeout',
        'RequestTimeoutException',
        'TransactionConflictException',
    )

    @classmethod
    def _day_check_failing_with(cls, code: str) -> tuple[bool, MagicMock]:
        from aggregator.handler import _day_has_aggregates

        with patch('aggregator.handler.aggregates_table') as table, \
                patch('aggregator.handler.logger') as logger:
            table.get_item.side_effect = ClientError({'Error': {'Code': code, 'Message': 'x'}}, 'GetItem')
            live = _day_has_aggregates(cls.DAY)
        return live, logger

    @pytest.mark.parametrize('code', TRANSIENT)
    def test_a_transient_code_is_a_warning_naming_the_day(self, code):
        live, logger = self._day_check_failing_with(code)

        assert live is True
        assert logger.warning.call_count == 1
        assert self.DAY in logger.warning.call_args.args[0]
        logger.error.assert_not_called()
        logger.exception.assert_not_called()

    @pytest.mark.parametrize('code', ['AccessDeniedException', 'ValidationException',
                                      'ResourceNotFoundException', ''])
    def test_anything_else_is_an_error_naming_the_day_and_the_code(self, code):
        live, logger = self._day_check_failing_with(code)

        assert live is True
        assert logger.exception.call_count == 1
        logger.error.assert_not_called()
        logged = logger.exception.call_args.args[0]
        assert self.DAY in logged
        assert f'`{code}`' in logged
        logger.warning.assert_not_called()

    def test_the_allowlist_is_exactly_these_codes(self):
        from aggregator.handler import _TRANSIENT_READ_ERRORS

        assert frozenset(self.TRANSIENT) == _TRANSIENT_READ_ERRORS


class TestTheArrivalTransactionBudgetIsThreeAttemptsAndTwoWaits:
    """The numbers the module docstring states: 3 attempts, backoff 50 ms doubling,
    half-jittered — so 25-50 ms then 50-100 ms, at most ~150 ms in total."""

    @staticmethod
    def _conflict() -> ClientError:
        return ClientError(
            {'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
             'CancellationReasons': [{'Code': 'None'}, {'Code': 'TransactionConflict'}]},
            'TransactWriteItems',
        )

    def _attempts_and_sleeps(self, jitter_draw: int) -> tuple[int, list[float]]:
        from aggregator.handler import _claimed_transaction

        with patch('aggregator.handler.aggregates_table') as table, \
                patch('aggregator.handler.IDEMPOTENCY_TABLE', 'dedupe'), \
                patch('aggregator.handler.time.sleep') as slept, \
                patch('aggregator.handler.secrets.randbelow', return_value=jitter_draw), \
                patch('aggregator.handler.metrics'):
            table.meta.client.transact_write_items.side_effect = self._conflict()
            with pytest.raises(ClientError):
                _claimed_transaction('record-1', [{'Update': {'TableName': 't', 'Key': {}, 'UpdateExpression': ''}}])
        return table.meta.client.transact_write_items.call_count, [c.args[0] for c in slept.call_args_list]

    def test_a_permanently_contended_record_is_attempted_three_times(self):
        attempts, sleeps = self._attempts_and_sleeps(jitter_draw=0)

        assert attempts == 3
        assert len(sleeps) == 2

    def test_the_shortest_waits_are_25_and_50_milliseconds(self):
        _, sleeps = self._attempts_and_sleeps(jitter_draw=0)

        assert sleeps == pytest.approx([0.025, 0.05])

    def test_the_longest_waits_stay_under_50_and_100_milliseconds(self):
        _, sleeps = self._attempts_and_sleeps(jitter_draw=499)

        assert sleeps == pytest.approx([0.04995, 0.0999])
        assert sleeps[0] < 0.05
        assert sleeps[1] < 0.1


class TestTheHandlerReportsPerRecordThroughItsBatchProcessor:
    """`processor` is the module-level BatchProcessor every stream batch goes through;
    nothing else in the suite invokes `lambda_handler`, so a broken binding there was
    invisible. One good record and one poisoned record, end to end."""

    @staticmethod
    def _event(*records: tuple[dict, str]) -> dict:
        """A stream batch of `(record, sequence_number)` pairs, as Lambda delivers it."""
        return {'Records': [
            {**record, 'eventSource': 'aws:dynamodb', 'eventID': f'evt-{sequence_number}',
             'dynamodb': {**record['dynamodb'], 'SequenceNumber': sequence_number}}
            for record, sequence_number in records
        ]}

    def test_a_clean_batch_reports_no_failures_and_moves_every_counter(
        self, sample_dynamodb_stream_record, lambda_context,
    ):
        from aggregator.handler import lambda_handler

        with patch('aggregator.handler.aggregates_table') as table:
            response = lambda_handler(self._event((sample_dynamodb_stream_record, '111')), lambda_context)

        assert response == {'batchItemFailures': []}
        # six counters (no urgent row for a low-urgency item) plus the running average
        assert table.update_item.call_count == 7

    def test_a_record_that_fails_is_reported_by_its_sequence_number_alone(
        self, sample_dynamodb_stream_record, lambda_context,
    ):
        """Partial failure: the poisoned record's sequence number is returned so the
        stream redelivers only it, while the good record's writes stand."""
        from aggregator.handler import lambda_handler

        poisoned = {**sample_dynamodb_stream_record,
                    'dynamodb': {'NewImage': {**sample_dynamodb_stream_record['dynamodb']['NewImage'],
                                              'date': {'S': '2025-01-16'}}}}
        event = self._event((sample_dynamodb_stream_record, '111'), (poisoned, '222'))

        def throttle_the_second_day(**kwargs):
            if kwargs['Key']['sk'] == '2025-01-16':
                raise _throttled()
            return {}

        with patch('aggregator.handler.aggregates_table') as table:
            table.update_item.side_effect = throttle_the_second_day
            response = lambda_handler(event, lambda_context)

        assert response == {'batchItemFailures': [{'itemIdentifier': '222'}]}

    def test_a_batch_that_fails_entirely_is_raised_for_the_stream_to_redeliver(
        self, sample_dynamodb_stream_record, lambda_context,
    ):
        from aws_lambda_powertools.utilities.batch.exceptions import BatchProcessingError

        from aggregator.handler import lambda_handler

        with patch('aggregator.handler.aggregates_table') as table:
            table.update_item.side_effect = _throttled()
            with pytest.raises(BatchProcessingError):
                lambda_handler(self._event((sample_dynamodb_stream_record, '222')), lambda_context)


class TestAnItemMissingEveryDimensionBucketsUnderTheDefaults:
    def test_the_defaults_are_the_bucket_names_the_reader_groups_by(self):
        from aggregator.handler import counter_dimensions

        assert counter_dimensions({}) == [
            ('METRIC#daily_total', 'count'),
            ('METRIC#daily_source#unknown', 'count'),
            ('METRIC#daily_category#other', 'count'),
            ('METRIC#daily_sentiment#neutral', 'count'),
            ('METRIC#persona#unknown', 'count'),
            ('METRIC#category_sentiment#other#neutral', 'count'),
        ]

    def test_a_populated_urgent_item_names_every_bucket_from_its_fields(self):
        from aggregator.handler import counter_dimensions

        item = {'source_platform': 'webscraper', 'category': 'billing', 'sentiment_label': 'negative',
                'urgency': 'high', 'persona_type': 'churn_risk'}

        assert counter_dimensions(item) == [
            ('METRIC#daily_total', 'count'),
            ('METRIC#daily_source#webscraper', 'count'),
            ('METRIC#daily_category#billing', 'count'),
            ('METRIC#daily_sentiment#negative', 'count'),
            ('METRIC#persona#churn_risk', 'count'),
            ('METRIC#urgent', 'count'),
            ('METRIC#category_sentiment#billing#negative', 'count'),
        ]


class TestTheRefusalHalfOfARequestIsOptionalAndTheUpdateHalfRequired:
    """`_RefusalReport` is `total=False`; `_UpdateRequest` adds four required keys.

    Totality is static, so its one runtime face is the key partition the classes
    expose. Pinned as literal frozensets: an increment legitimately omits both
    refusal keys (`_counter_request` merges `{}`), and every request must carry
    the four `update_item` arguments.
    """

    REFUSAL_KEYS: ClassVar[frozenset[str]] = frozenset({
        'ConditionExpression', 'ReturnValuesOnConditionCheckFailure',
    })
    UPDATE_KEYS: ClassVar[frozenset[str]] = frozenset({
        'Key', 'UpdateExpression', 'ExpressionAttributeNames', 'ExpressionAttributeValues',
    })

    def test_the_refusal_report_has_only_optional_keys(self):
        from aggregator.handler import _RefusalReport

        assert _RefusalReport.__optional_keys__ == self.REFUSAL_KEYS
        assert _RefusalReport.__required_keys__ == frozenset()

    def test_the_update_request_requires_the_update_half_and_inherits_the_optional_refusal_half(self):
        from aggregator.handler import _UpdateRequest

        assert _UpdateRequest.__required_keys__ == self.UPDATE_KEYS
        assert _UpdateRequest.__optional_keys__ == self.REFUSAL_KEYS

    def test_an_increment_carries_exactly_the_required_keys_and_a_decrement_adds_the_refusal_half(self):
        from aggregator.handler import _counter_request

        assert set(_counter_request('METRIC#daily_total', '2025-01-01', 'count', 1)) == self.UPDATE_KEYS
        assert set(_counter_request('METRIC#daily_total', '2025-01-01', 'count', -1)) == (
            self.UPDATE_KEYS | self.REFUSAL_KEYS
        )
