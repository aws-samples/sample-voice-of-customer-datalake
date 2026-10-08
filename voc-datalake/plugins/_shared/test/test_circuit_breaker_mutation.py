"""Mutation hardening for `_shared/circuit_breaker.py`.

`test_circuit_breaker.py` pins the shape of the breaker (the `TRIPPED` key it
reads and deletes, that a failure is written and the threshold trips) but a
mutation run found 50 of 99 mutants it could not see — everything the breaker
says to DynamoDB, EventBridge, the audit log and CloudWatch beyond "a call
happened":

* the FAILURE WINDOW: the query's exact key condition and placeholders, with
  ``:start`` = ``now - WINDOW_MINUTES`` (a ``+`` would look into the future
  and never find a failure);
* the FAILURE ROW as a whole — ``sk`` is the ISO timestamp, ``source`` the
  GSI-shaped ``FAILURES#<id>#<iso>``, ``error`` cut at exactly 500
  characters, ``ttl`` exactly 24 hours ahead;
* the THRESHOLD BOUNDARY: ``recent + 1 >= FAILURE_THRESHOLD`` — one short of
  the threshold does not trip, exactly the threshold trips with that count;
* the TRIP itself: ``disable_rule`` named with the rule CDK passed in
  ``INGEST_SCHEDULE_RULE_NAME`` (and not called when there is none), the
  ``TRIPPED`` row's ``source``/``tripped_at``/``last_error`` (cut at 500), the
  ``plugin.disabled`` audit event with ``success=True`` and its three details,
  and the ``CIRCUIT BREAKER:`` warning;
* every FAILURE LOG: the exact text and ``exc_info=True`` for a failing
  query, delete and get, plus ``is_open`` answering ``False`` on a failure;
* the IMPORT-TIME contract: the threshold (default 5), window (default 15)
  and table name (default ``''``) are read from the variables of those exact
  names, and the plugins root is put at the FRONT of ``sys.path``.
"""
import os
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared import circuit_breaker
from _shared.circuit_breaker import CircuitBreaker
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh

MODULE_PATH = Path(circuit_breaker.__file__).resolve()
PLUGINS_ROOT = str(MODULE_PATH.parents[1])

NOW = datetime(2025, 3, 1, 12, 0, 0, tzinfo=UTC)
NOW_ISO = '2025-03-01T12:00:00+00:00'
FIFTEEN_MINUTES_BEFORE_ISO = '2025-03-01T11:45:00+00:00'
TWENTY_FOUR_HOURS_AHEAD = 1740916800  # 2025-03-02T12:00:00+00:00
LONG_ERROR = 'x' * 499 + 'Y' + 'z' * 100  # character 500 is the last kept

THROTTLED = ClientError(
    {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow down'}},
    'Query',
)


def _load_fresh_module():
    """Execute the module's file again, in a module registered nowhere (see `fresh_import.load_fresh`)."""
    return load_fresh('_shared._circuit_breaker_under_test', MODULE_PATH)


@pytest.fixture
def restored_sys_path() -> Iterator[list[str]]:
    before = list(sys.path)
    yield before
    sys.path[:] = before


@pytest.fixture
def table() -> Iterator[MagicMock]:
    """The watermarks table double every breaker in the test resolves to."""
    with patch('_shared.circuit_breaker.get_dynamodb_resource') as get_dynamo:
        doubled = MagicMock()
        doubled.query.return_value = {'Items': []}
        get_dynamo.return_value.Table.return_value = doubled
        yield doubled


@pytest.fixture
def fixed_clock() -> Iterator[MagicMock]:
    with patch('_shared.circuit_breaker.datetime') as clock:
        clock.now.return_value = NOW
        yield clock


@pytest.fixture
def breaker_logger() -> Iterator[MagicMock]:
    with patch('_shared.circuit_breaker.logger') as logger:
        yield logger


@pytest.fixture
def trip_world() -> Iterator[SimpleNamespace]:
    """A schedule rule named by CDK, a doubled client, and the audit emitter doubled.

    Only the client is doubled, not the `get_eventbridge_client` factory, so the
    factory's real existence in `shared.aws` is part of what these tests use.
    """
    events = MagicMock()
    with (
        patch('shared.aws._eventbridge_client', events),
        patch('_shared.audit.emit_audit_event') as emit,
        patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': 'rule-cdk-resolved'}),
    ):
        yield SimpleNamespace(events=events, emit=emit)


class TestTheImportTimeContract:
    @pytest.mark.usefixtures('restored_sys_path')
    @pytest.mark.parametrize(
        ('variable', 'attribute', 'value', 'expected'),
        [
            ('CIRCUIT_BREAKER_THRESHOLD', 'FAILURE_THRESHOLD', '7', 7),
            ('CIRCUIT_BREAKER_WINDOW', 'WINDOW_MINUTES', '45', 45),
            ('WATERMARKS_TABLE', 'WATERMARKS_TABLE', 'table-from-env', 'table-from-env'),
        ],
    )
    def test_each_setting_is_read_from_the_variable_of_that_exact_name(
        self, variable, attribute, value, expected
    ):
        with patch.dict(os.environ, {variable: value}):
            module = _load_fresh_module()

        assert getattr(module, attribute) == expected

    @pytest.mark.usefixtures('restored_sys_path')
    def test_the_defaults_are_five_failures_in_fifteen_minutes_and_no_table(self):
        with patch.dict(os.environ):
            for variable in ('CIRCUIT_BREAKER_THRESHOLD', 'CIRCUIT_BREAKER_WINDOW', 'WATERMARKS_TABLE'):
                os.environ.pop(variable, None)
            module = _load_fresh_module()

        assert module.FAILURE_THRESHOLD == 5
        assert module.WINDOW_MINUTES == 15
        assert module.WATERMARKS_TABLE == ''

    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_module, restored_sys_path, PLUGINS_ROOT)


@pytest.mark.usefixtures('fixed_clock')
class TestRecordingAFailure:
    @patch('_shared.circuit_breaker.WINDOW_MINUTES', 15)
    def test_counts_the_failures_of_the_last_window_minutes_only(self, table):
        CircuitBreaker('webscraper').record_failure('boom')

        table.query.assert_called_once_with(
            KeyConditionExpression='pk = :pk AND sk BETWEEN :start AND :end',
            ExpressionAttributeValues={
                ':pk': 'FAILURES#webscraper',
                ':start': FIFTEEN_MINUTES_BEFORE_ISO,
                ':end': NOW_ISO,
            },
        )

    def test_writes_the_failure_row_with_the_error_cut_at_500_and_a_24_hour_ttl(self, table):
        CircuitBreaker('webscraper').record_failure(LONG_ERROR)

        table.put_item.assert_called_once_with(Item={
            'pk': 'FAILURES#webscraper',
            'sk': NOW_ISO,
            'source': f'FAILURES#webscraper#{NOW_ISO}',
            'error': 'x' * 499 + 'Y',
            'ttl': TWENTY_FOUR_HOURS_AHEAD,
        })
        assert len(table.put_item.call_args.kwargs['Item']['error']) == 500

    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3)
    def test_one_failure_short_of_the_threshold_does_not_trip(self, table):
        table.query.return_value = {'Items': [{'sk': 'earlier'}]}
        breaker = CircuitBreaker('webscraper')

        with patch.object(breaker, '_trip_breaker') as trip:
            breaker.record_failure('second')

        trip.assert_not_called()

    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3)
    def test_reaching_the_threshold_trips_with_that_exact_count_and_error(self, table):
        table.query.return_value = {'Items': [{'sk': 'earlier'}, {'sk': 'later'}]}
        breaker = CircuitBreaker('webscraper')

        with patch.object(breaker, '_trip_breaker') as trip:
            breaker.record_failure('third')

        trip.assert_called_once_with(3, 'third')

    def test_a_failing_query_is_warned_with_its_cause_and_traceback_and_writes_nothing(
        self, table, breaker_logger
    ):
        table.query.side_effect = THROTTLED

        CircuitBreaker('webscraper').record_failure('boom')

        breaker_logger.warning.assert_called_once_with(
            f'Failed to record failure in circuit breaker: {THROTTLED}', exc_info=True
        )
        table.put_item.assert_not_called()


@pytest.mark.usefixtures('fixed_clock')
class TestTrippingTheBreaker:
    @pytest.mark.usefixtures('table')
    def test_disables_the_rule_cdk_named(self, trip_world):
        CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        trip_world.events.disable_rule.assert_called_once_with(Name='rule-cdk-resolved')

    @pytest.mark.usefixtures('table')
    def test_the_rule_name_is_read_at_trip_time_not_rebuilt_from_the_plugin_id(self, trip_world):
        # A name derived from the plugin id would be right only by coincidence
        # and wrong under a deployment prefix; CDK's string is the one the rule
        # and the DisableRule grant were built from.
        with patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': 'p-voc-ingest-other-schedule-1-r'}):
            CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        trip_world.events.disable_rule.assert_called_once_with(Name='p-voc-ingest-other-schedule-1-r')

    def test_an_unscheduled_plugin_disables_nothing_and_still_records_the_trip(
        self, table, trip_world
    ):
        with patch.dict(os.environ):
            os.environ.pop('INGEST_SCHEDULE_RULE_NAME', None)
            CircuitBreaker('s3_import')._trip_breaker(5, 'boom')

        trip_world.events.disable_rule.assert_not_called()
        assert table.put_item.call_args.kwargs['Item']['pk'] == 'CIRCUIT#s3_import'
        trip_world.emit.assert_called_once()

    @pytest.mark.usefixtures('trip_world')
    def test_writes_the_tripped_row_with_the_error_cut_at_500(self, table):
        CircuitBreaker('webscraper')._trip_breaker(5, LONG_ERROR)

        table.put_item.assert_called_once_with(Item={
            'pk': 'CIRCUIT#webscraper',
            'sk': 'TRIPPED',
            'source': 'CIRCUIT#webscraper#TRIPPED',
            'tripped_at': NOW_ISO,
            'failure_count': 5,
            'last_error': 'x' * 499 + 'Y',
        })

    @pytest.mark.usefixtures('table')
    def test_emits_a_successful_plugin_disabled_audit_event_with_the_whole_error(self, trip_world):
        CircuitBreaker('webscraper')._trip_breaker(5, LONG_ERROR)

        trip_world.emit.assert_called_once_with('plugin.disabled', 'webscraper', True, {
            'reason': 'circuit_breaker',
            'failure_count': 5,
            'last_error': LONG_ERROR,
        })

    @pytest.mark.usefixtures('table', 'trip_world')
    def test_warns_which_plugin_was_disabled_after_how_many_failures(self, breaker_logger):
        CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        breaker_logger.warning.assert_called_once_with(
            'CIRCUIT BREAKER: Disabled webscraper after 5 failures'
        )
        breaker_logger.exception.assert_not_called()

    def test_a_failing_disable_rule_is_logged_with_its_cause_and_stops_the_trip(
        self, table, trip_world, breaker_logger
    ):
        trip_world.events.disable_rule.side_effect = RuntimeError('no such rule')

        CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        breaker_logger.exception.assert_called_once_with('Failed to trip circuit breaker: no such rule')
        table.put_item.assert_not_called()
        trip_world.emit.assert_not_called()
        breaker_logger.warning.assert_not_called()


class TestRecordingASuccess:
    def test_a_failing_delete_is_logged_at_debug_with_its_cause_and_traceback(self, table, breaker_logger):
        table.delete_item.side_effect = THROTTLED

        assert CircuitBreaker('webscraper').record_success() is None

        breaker_logger.debug.assert_called_once_with(
            f'Failed to clear circuit breaker state: {THROTTLED}', exc_info=True
        )


class TestAskingWhetherTheBreakerIsOpen:
    def test_a_failing_read_answers_closed_and_is_logged_at_debug_with_its_cause(
        self, table, breaker_logger
    ):
        table.get_item.side_effect = THROTTLED

        assert CircuitBreaker('webscraper').is_open() is False

        breaker_logger.debug.assert_called_once_with(
            f'Failed to check circuit breaker state: {THROTTLED}', exc_info=True
        )
