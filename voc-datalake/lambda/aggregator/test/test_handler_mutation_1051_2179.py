"""Mutation-hardening tests for `aggregator/handler.py`, lines 1051-2179.

Every test here exists because a mutant of that range survived test_handler.py
and the first slice's suite. What those suites could not see:

* the subcategory row's exact key-safety rule — the 64-character boundary
  (`== 64` counts, `== 65` does not), a `#` in the CATEGORY as well as in the
  subcategory, and a non-string category. test_handler.py only ever builds items
  whose subcategory is absent, so none of those branches was reached;
* `apply_counter_keys`' landed COUNT. Every caller compared it with zero, so a
  count of one, minus one or two per landed write read the same;
* the arrival transaction's operator-facing lines: the redelivery and retry log
  messages (an operator timing a slow record reads "attempt 2 of 3"), the metric
  VALUE of one per event, the jitter's `randbelow(500)` (501 would let the wait
  reach the full nominal delay), and the zero-attempt guard's message. The
  existing suites drive these through moto and only read the table back;
* the cancellation predicates' edges: a `CancellationReasons` that is a non-empty
  non-list, and a list of nothing but `'None'`;
* `_reverse_a_pre_deploy_persona_row`'s RETURN value, which only a log line
  spends, and the day its decline names — the EARLIEST of the dates, which is not
  the date of the smallest key.
"""
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, cast
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

import aggregator.handler as handler
from aggregator.handler import CounterWrite, apply_counter_keys, counter_dimensions, subcategory_bucket

if TYPE_CHECKING:
    from botocore.exceptions import _ClientErrorResponseTypeDef

KEY = 'aggregator#stream#record-1'
# Two real counter entries, built by the module's own builder so they carry its type.
ITEMS = handler.counter_transaction_items({('METRIC#a', '2026-01-02', 'count'),
                                           ('METRIC#b', '2026-01-02', 'count')})


def _cancelled(*codes: str) -> ClientError:
    """A TransactionCanceledException naming `codes`, one reason per item."""
    return ClientError(
        {'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
         'CancellationReasons': [{'Code': code} for code in codes]},
        'TransactWriteItems',
    )


@contextmanager
def _transaction(*outcomes: Exception | None) -> Iterator[dict[str, MagicMock]]:
    """`_claimed_transaction` against a client whose calls end as `outcomes`, in order.

    Exhaustible: a retry-forever mutant dies on StopIteration rather than looping.
    """
    table = MagicMock()
    table.meta.client.transact_write_items.side_effect = [
        outcome if outcome is not None else {} for outcome in outcomes]
    with patch.object(handler, 'aggregates_table', table), \
            patch.object(handler, 'IDEMPOTENCY_TABLE', 'dedupe'), \
            patch.object(handler, 'logger') as logger, \
            patch.object(handler, 'metrics') as metrics, \
            patch('aggregator.handler.time.sleep') as slept, \
            patch('aggregator.handler.secrets.randbelow', return_value=0) as jitter:
        yield {'client': table.meta.client, 'logger': logger, 'metrics': metrics,
               'sleep': slept, 'jitter': jitter}


class TestTheSubcategoryRowIsKeySafe:
    def test_an_item_with_a_subcategory_gets_exactly_that_row(self):
        dimensions = counter_dimensions({'category': 'shipping', 'subcategory': 'late'})

        assert dimensions[-1] == ('METRIC#daily_subcategory#shipping#late', 'count')

    @pytest.mark.parametrize('length', [1, 63, 64])
    def test_a_subcategory_up_to_64_characters_counts(self, length):
        value = 'x' * length

        assert subcategory_bucket({'category': 'shipping', 'subcategory': value}) == value

    @pytest.mark.parametrize('value', ['x' * 65, '', 'a#b', '#', 'two words', 'tab\there', 7, None])
    def test_a_value_that_cannot_be_a_configured_name_gets_no_row(self, value):
        assert subcategory_bucket({'category': 'shipping', 'subcategory': value}) is None

    def test_an_uncategorised_item_counts_under_other(self):
        assert subcategory_bucket({'subcategory': 'late'}) == 'late'
        assert counter_dimensions({'subcategory': 'late'})[-1] == (
            'METRIC#daily_subcategory#other#late', 'count')

    @pytest.mark.parametrize('category', ['ship#ping', '#', 42])
    def test_a_category_that_cannot_head_the_key_gets_no_row(self, category):
        assert subcategory_bucket({'category': category, 'subcategory': 'late'}) is None


class TestApplyCounterKeysCountsWhatLanded:
    @pytest.mark.parametrize(('outcomes', 'landed'), [
        ([CounterWrite.LANDED, CounterWrite.LANDED, CounterWrite.LANDED], 3),
        ([CounterWrite.LANDED, CounterWrite.ROW_ABSENT, CounterWrite.LANDED], 2),
        ([CounterWrite.REFUSED_AT_FLOOR, CounterWrite.ROW_ABSENT, CounterWrite.LANDED], 1),
        ([CounterWrite.REFUSED_AT_FLOOR, CounterWrite.ROW_ABSENT, CounterWrite.ROW_ABSENT], 0),
    ])
    def test_the_count_is_the_number_of_landed_writes(self, outcomes, landed):
        keys = {('METRIC#a', '2026-01-02', 'count'), ('METRIC#b', '2026-01-02', 'count'),
                ('METRIC#c', '2026-01-02', 'count')}
        written: MagicMock
        with patch('aggregator.handler.update_counter', side_effect=outcomes) as written:
            count, by_key = apply_counter_keys(keys, -1)

        assert count == landed
        assert by_key == dict(zip(sorted(keys), outcomes, strict=True))
        assert written.call_args_list == [
            ((pk, date, field), {'increment': -1}) for pk, date, field in sorted(keys)]


class TestTheArrivalTransactionSaysWhatItDid:
    def test_a_redelivery_is_logged_and_counted_once(self):
        with _transaction(_cancelled('ConditionalCheckFailed', 'None', 'None')) as fakes:
            assert handler._claimed_transaction(KEY, ITEMS) is False

        fakes['logger'].info.assert_called_once_with(
            'Stream record aggregator#stream#record-1 was already applied; '
            'leaving 2 aggregate write(s) alone')
        fakes['metrics'].add_metric.assert_called_once_with(
            name='AggregateRecordReplayed', unit='Count', value=1)

    def test_each_retry_is_logged_with_its_attempt_number_and_counted_once(self):
        conflict = _cancelled('None', 'TransactionConflict', 'None')
        with _transaction(conflict, conflict, None) as fakes:
            assert handler._claimed_transaction(KEY, ITEMS) is True

        assert fakes['logger'].warning.call_args_list == [call(
            'Aggregate transaction for aggregator#stream#record-1 was cancelled for a '
            'transient reason (contention or throttling); retrying '
            f'(attempt {n} of 3)') for n in (2, 3)]
        assert fakes['metrics'].add_metric.call_args_list == [
            call(name='AggregateTransactionConflicted', unit='Count', value=1)] * 2

    def test_the_jitter_draws_below_500_thousandths(self):
        conflict = _cancelled('None', 'TransactionConflict', 'None')
        with _transaction(conflict, None) as fakes:
            handler._claimed_transaction(KEY, ITEMS)

        fakes['jitter'].assert_called_once_with(500)
        fakes['sleep'].assert_called_once_with(0.025)

    def test_no_attempt_at_all_raises_rather_than_reporting_a_redelivery(self):
        with _transaction(), patch.object(handler, 'TRANSACT_WRITE_ATTEMPTS', 0), \
                pytest.raises(RuntimeError) as raised:
            handler._claimed_transaction(KEY, ITEMS)

        assert str(raised.value) == (
            'TRANSACT_WRITE_ATTEMPTS is not at least 1, so no aggregate transaction was '
            'attempted. Raising rather than reporting a record that was never applied.')


class TestTheCancellationPredicatesEdges:
    def test_reasons_that_are_not_a_list_are_unreadable(self):
        # Wrong-shaped on purpose (a mapping where DynamoDB sends a list), so the
        # stubs' TypedDict cannot describe it; the cast is for them, not the value.
        response: dict[str, Any] = {
            'Error': {'Code': 'TransactionCanceledException', 'Message': 'cancelled'},
            'CancellationReasons': {'Code': 'ConditionalCheckFailed'}}
        error = ClientError(cast('_ClientErrorResponseTypeDef', response), 'TransactWriteItems')

        assert handler._cancellation_reasons(error) is None
        assert handler._claim_was_refused(error) is False
        assert handler._conflicted(error) is False

    def test_an_error_that_is_not_a_cancellation_is_not_a_retryable_conflict(self):
        error = ClientError({'Error': {'Code': 'ValidationException', 'Message': 'bad'}},
                            'TransactWriteItems')

        assert handler._conflicted(error) is False

    def test_reasons_naming_no_failure_are_not_a_retryable_conflict(self):
        assert handler._conflicted(_cancelled('None', 'None')) is False


PERSONA_KEY_LATE: tuple[str, str, str] = ('METRIC#persona#advocate', '2026-03-09', 'count')
PERSONA_KEY_EARLY: tuple[str, str, str] = ('METRIC#persona#prospect', '2026-03-01', 'count')


class TestThePreDeployPersonaReversalReportsItsWrites:
    def test_no_absent_persona_row_means_no_write(self):
        outcomes = {PERSONA_KEY_LATE: CounterWrite.LANDED,
                    ('METRIC#daily_total', '2026-03-09', 'count'): CounterWrite.ROW_ABSENT}
        written: MagicMock
        with patch.object(handler, 'update_counter') as written:
            assert handler._reverse_a_pre_deploy_persona_row({'persona_name': 'Ops'}, outcomes) == 0

        written.assert_not_called()

    @pytest.mark.parametrize(('results', 'landed'), [
        ([CounterWrite.LANDED, CounterWrite.LANDED], 2),
        ([CounterWrite.ROW_ABSENT, CounterWrite.LANDED], 1),
        ([CounterWrite.ROW_ABSENT, CounterWrite.REFUSED_AT_FLOOR], 0),
    ])
    def test_the_return_is_the_legacy_writes_that_landed(self, results, landed):
        outcomes = dict.fromkeys((PERSONA_KEY_LATE, PERSONA_KEY_EARLY), CounterWrite.ROW_ABSENT)
        written: MagicMock
        with patch.object(handler, 'update_counter', side_effect=results) as written, \
                patch.object(handler, 'logger') as logger:
            assert handler._reverse_a_pre_deploy_persona_row({'persona_name': 'Ops'}, outcomes) == landed

        assert written.call_args_list == [
            call('METRIC#persona#Ops', '2026-03-09', 'count', increment=-1),
            call('METRIC#persona#Ops', '2026-03-01', 'count', increment=-1)]
        assert logger.info.call_args_list == [call(
            f"Persona decrement on {pk}/{date} found no row, so this item's insert "
            "ran before the axis moved; also reversing METRIC#persona#Ops, the row it created")
            for pk, date, _ in (PERSONA_KEY_LATE, PERSONA_KEY_EARLY)]

    def test_a_legacy_name_that_is_a_live_archetype_is_declined_on_the_earliest_day(self):
        outcomes = dict.fromkeys((PERSONA_KEY_LATE, PERSONA_KEY_EARLY), CounterWrite.ROW_ABSENT)
        declined: MagicMock
        written: MagicMock
        with patch.object(handler, '_log_decline') as declined, \
                patch.object(handler, 'update_counter') as written:
            assert handler._reverse_a_pre_deploy_persona_row(
                {'persona_name': 'churn_risk'}, outcomes) == 0

        written.assert_not_called()
        declined.assert_called_once_with(
            'the pre-deploy persona reversal', 'METRIC#persona#churn_risk', '2026-03-01',
            '`persona_name` is `churn_risk`, which is one of the archetypes this deploy '
            'actively writes, so that row cannot be distinguished from a live one and '
            'must not be decremented')
