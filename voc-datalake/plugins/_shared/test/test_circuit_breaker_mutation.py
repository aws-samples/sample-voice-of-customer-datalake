"""Mutation hardening for `_shared/circuit_breaker.py`.

`test_circuit_breaker.py` pins the shape of the breaker (the `TRIPPED` key it
reads and deletes, that a failure is written and the threshold trips) but a
mutation run found 50 of 99 mutants it could not see — everything the breaker
says to DynamoDB, EventBridge, the audit log and CloudWatch beyond "a call
happened":

* the FAILURE WINDOW: the query's exact key condition and placeholders, with
  ``:start`` = ``now - WINDOW_MINUTES`` (a ``+`` would look into the future
  and never find a failure);
* the FAILURE ROW as a whole — ``sk`` is the ISO timestamp, ``error`` cut at
  exactly 500 characters, ``ttl`` exactly 24 hours ahead;
* the THRESHOLD BOUNDARY: ``recent + 1 >= FAILURE_THRESHOLD`` — one short of
  the threshold does not trip, exactly the threshold trips with that count;
* the TRIP itself: the workspace's ``TRIPPED`` row's ``tripped_at``/``last_error``
  (cut at 500), the ``plugin.disabled`` audit event with ``success=True`` and its
  four details (the workspace included), the ``CIRCUIT BREAKER:`` warning, and
  that no schedule rule is disabled (the plugin's one rule serves every workspace);
  and a deployment-wide trip's: the ``CIRCUIT#`` row first, then the rule CDK named
  (read at trip time) disabled, a failing disable logged and metered without
  costing the row or the audit event, nothing disabled for an unscheduled plugin;
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
from _shared.test.workspace_fixtures import SCOPE, WS
from shared.test.clock import frozen_clock

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
    """The aggregates table double every breaker in the test resolves to."""
    with (
        patch('_shared.circuit_breaker.AGGREGATES_TABLE', 'test-aggregates'),
        patch('_shared.circuit_breaker.get_dynamodb_resource') as get_dynamo,
    ):
        doubled = MagicMock()
        doubled.query.return_value = {'Items': []}
        get_dynamo.return_value.Table.return_value = doubled
        yield doubled


@pytest.fixture
def fixed_clock() -> Iterator[MagicMock]:
    with frozen_clock('_shared.circuit_breaker') as clock:
        clock.now.return_value = NOW
        yield clock


@pytest.fixture
def breaker_logger() -> Iterator[MagicMock]:
    with patch('_shared.circuit_breaker.logger') as logger:
        yield logger


FAILURES_PK = f'WS#{WS}#FAILURES#webscraper'
TRIPPED_PK = f'WS#{WS}#CIRCUIT#webscraper'


def _breaker(plugin_id: str = 'webscraper') -> CircuitBreaker:
    return CircuitBreaker(plugin_id, SCOPE)


@pytest.fixture
def trip_world() -> Iterator[SimpleNamespace]:
    """The EventBridge client accessor the breaker resolves (``get_events``; its client ``events``) and the audit
    emitter doubled, with the plugin's schedule rule named as CDK names it. A workspace's trip must never build or
    use the client; a deployment-wide trip disables that rule."""
    with (
        patch('_shared.circuit_breaker.get_eventbridge_client') as get_events,
        patch('_shared.audit.emit_audit_event') as emit,
        patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': 'rule-cdk-resolved'}),
    ):
        yield SimpleNamespace(get_events=get_events, events=get_events.return_value, emit=emit)


class TestTheImportTimeContract:
    @pytest.mark.usefixtures('restored_sys_path')
    @pytest.mark.parametrize(
        ('variable', 'attribute', 'value', 'expected'),
        [
            ('AGGREGATES_TABLE', 'AGGREGATES_TABLE', 'table-from-env', 'table-from-env'),
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
            os.environ.pop('AGGREGATES_TABLE', None)
            module = _load_fresh_module()

        assert module.FAILURE_THRESHOLD == 5
        assert module.WINDOW_MINUTES == 15
        assert module.AGGREGATES_TABLE == ''

    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_module, restored_sys_path, PLUGINS_ROOT)


@pytest.mark.usefixtures('fixed_clock')
class TestRecordingAFailure:
    @patch('_shared.circuit_breaker.WINDOW_MINUTES', 15)
    def test_counts_the_failures_of_the_last_window_minutes_only(self, table):
        _breaker().record_failure('boom')

        table.query.assert_called_once_with(
            KeyConditionExpression='#p = :p AND sk BETWEEN :start AND :end',
            ExpressionAttributeNames={'#p': 'pk'},
            ExpressionAttributeValues={
                ':start': FIFTEEN_MINUTES_BEFORE_ISO,
                ':end': NOW_ISO,
                ':p': FAILURES_PK,
            },
        )

    def test_writes_the_failure_row_with_the_error_cut_at_500_and_a_24_hour_ttl(self, table):
        _breaker().record_failure(LONG_ERROR)

        table.put_item.assert_called_once_with(Item={
            'pk': FAILURES_PK,
            'sk': NOW_ISO,
            'error': 'x' * 499 + 'Y',
            'ttl': TWENTY_FOUR_HOURS_AHEAD,
        })
        assert len(table.put_item.call_args.kwargs['Item']['error']) == 500

    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3)
    def test_one_failure_short_of_the_threshold_does_not_trip(self, table):
        table.query.return_value = {'Items': [{'sk': 'earlier'}]}
        breaker = _breaker()

        with patch.object(breaker, '_trip_breaker') as trip:
            breaker.record_failure('second')

        trip.assert_not_called()

    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3)
    def test_reaching_the_threshold_trips_with_that_exact_count_and_error(self, table):
        table.query.return_value = {'Items': [{'sk': 'earlier'}, {'sk': 'later'}]}
        breaker = _breaker()

        with patch.object(breaker, '_trip_breaker') as trip:
            breaker.record_failure('third')

        trip.assert_called_once_with(3, 'third')

    def test_a_failing_query_is_warned_with_its_cause_and_traceback_and_writes_nothing(
        self, table, breaker_logger
    ):
        table.query.side_effect = THROTTLED

        _breaker().record_failure('boom')

        breaker_logger.warning.assert_called_once_with(
            f'Failed to record failure in circuit breaker: {THROTTLED}', exc_info=True
        )
        table.put_item.assert_not_called()


@pytest.mark.usefixtures('fixed_clock')
class TestTrippingTheBreaker:
    def test_a_trip_disables_no_schedule_rule_even_with_one_named(self, table, trip_world):
        """The plugin's one rule serves every workspace (the tick fans out): a trip that disabled it would stop
        every other workspace's ingestion. Only the workspace's TRIPPED row stops its runs."""
        _breaker()._trip_breaker(5, 'boom')

        trip_world.get_events.assert_not_called()
        assert trip_world.events.mock_calls == []
        assert table.put_item.call_args.kwargs['Item']['pk'] == TRIPPED_PK
        trip_world.emit.assert_called_once()

    def test_an_unscheduled_plugin_records_the_trip_in_its_workspace(self, table, trip_world):
        with patch.dict(os.environ):
            os.environ.pop('INGEST_SCHEDULE_RULE_NAME', None)
            _breaker('s3_import')._trip_breaker(5, 'boom')

        trip_world.events.disable_rule.assert_not_called()
        assert table.put_item.call_args.kwargs['Item']['pk'] == f'WS#{WS}#CIRCUIT#s3_import'
        trip_world.emit.assert_called_once()

    @pytest.mark.usefixtures('trip_world')
    def test_writes_the_tripped_row_with_the_error_cut_at_500(self, table):
        _breaker()._trip_breaker(5, LONG_ERROR)

        table.put_item.assert_called_once_with(Item={
            'pk': TRIPPED_PK,
            'sk': 'TRIPPED',
            'tripped_at': NOW_ISO,
            'failure_count': 5,
            'last_error': 'x' * 499 + 'Y',
        })

    @pytest.mark.usefixtures('table')
    def test_emits_a_successful_plugin_disabled_audit_event_with_the_whole_error(self, trip_world):
        _breaker()._trip_breaker(5, LONG_ERROR)

        trip_world.emit.assert_called_once_with('plugin.disabled', 'webscraper', True, {
            'reason': 'circuit_breaker',
            'workspace_id': WS,
            'failure_count': 5,
            'last_error': LONG_ERROR,
        })

    @pytest.mark.usefixtures('table', 'trip_world')
    def test_warns_which_plugin_stopped_in_which_workspace_after_how_many_failures(self, breaker_logger):
        _breaker()._trip_breaker(5, 'boom')

        breaker_logger.warning.assert_called_once_with(
            f'CIRCUIT BREAKER: webscraper stopped in workspace {WS} after 5 failures'
        )
        breaker_logger.exception.assert_not_called()

    def test_the_tripped_row_is_written_before_the_audit_event(self, table, trip_world):
        order = MagicMock()
        order.attach_mock(table.put_item, 'put_item')
        order.attach_mock(trip_world.emit, 'emit')

        _breaker()._trip_breaker(5, 'boom')

        assert [c[0] for c in order.mock_calls] == ['put_item', 'emit']

    def test_a_failing_row_write_is_logged_and_metered_and_still_audits(
        self, table, trip_world, breaker_logger
    ):
        table.put_item.side_effect = THROTTLED

        with patch('_shared.circuit_breaker.metrics') as metrics:
            _breaker()._trip_breaker(5, 'boom')

        breaker_logger.exception.assert_called_once_with(f'Failed to record circuit breaker trip: {THROTTLED}')
        metrics.add_metric.assert_called_once_with(name='CircuitBreakerTripRecordFailed', unit='Count', value=1)
        trip_world.events.disable_rule.assert_not_called()
        trip_world.emit.assert_called_once()

    @pytest.mark.usefixtures('table')
    def test_a_failing_audit_emit_is_logged_and_does_not_raise(self, trip_world, breaker_logger):
        trip_world.emit.side_effect = RuntimeError('bus down')

        _breaker()._trip_breaker(5, 'boom')

        breaker_logger.exception.assert_called_once_with('Failed to emit circuit breaker audit event: bus down')

    def test_a_clean_trip_meters_nothing(self, table, trip_world):
        with patch('_shared.circuit_breaker.metrics') as metrics:
            _breaker()._trip_breaker(5, 'boom')

        metrics.add_metric.assert_not_called()
        table.put_item.assert_called_once()
        trip_world.emit.assert_called_once()


DEPLOYMENT_TRIPPED_PK = 'CIRCUIT#webscraper'


def _deployment_breaker(plugin_id: str = 'webscraper') -> CircuitBreaker:
    return CircuitBreaker(plugin_id)


@pytest.mark.usefixtures('fixed_clock')
class TestTrippingTheDeploymentWideBreaker:
    """A deployment-wide run's trip (no scope) is the one it always was: the API's ``CIRCUIT#`` row, the plugin's
    own schedule rule disabled (which, since the rule's tick fans out, stops every workspace's ticks too), the
    ``plugin.disabled`` audit event without a workspace, each step independent of the others."""

    @pytest.mark.usefixtures('table')
    def test_disables_the_rule_cdk_named_read_at_trip_time(self, trip_world):
        breaker = _deployment_breaker()
        with patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': 'rule-renamed-after-construction'}):
            breaker._trip_breaker(5, 'boom')

        trip_world.events.disable_rule.assert_called_once_with(Name='rule-renamed-after-construction')

    def test_the_row_is_written_before_the_rule_is_disabled_and_then_audited(self, table, trip_world):
        order = MagicMock()
        order.attach_mock(table.put_item, 'put_item')
        order.attach_mock(trip_world.events.disable_rule, 'disable_rule')
        order.attach_mock(trip_world.emit, 'emit')

        _deployment_breaker()._trip_breaker(5, LONG_ERROR)

        assert [c[0] for c in order.mock_calls] == ['put_item', 'disable_rule', 'emit']
        table.put_item.assert_called_once_with(Item={
            'pk': DEPLOYMENT_TRIPPED_PK, 'sk': 'TRIPPED', 'tripped_at': NOW_ISO, 'failure_count': 5,
            'last_error': 'x' * 499 + 'Y',
        })
        trip_world.emit.assert_called_once_with('plugin.disabled', 'webscraper', True, {
            'reason': 'circuit_breaker', 'failure_count': 5, 'last_error': LONG_ERROR,
        })

    def test_a_failing_disable_still_writes_the_row_audits_and_meters_it(self, table, trip_world, breaker_logger):
        failure = ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': 'no'}}, 'DisableRule')
        trip_world.events.disable_rule.side_effect = failure

        with patch('_shared.circuit_breaker.metrics') as metrics:
            _deployment_breaker()._trip_breaker(5, 'boom')

        assert table.put_item.call_args.kwargs['Item']['pk'] == DEPLOYMENT_TRIPPED_PK
        trip_world.emit.assert_called_once_with('plugin.disabled', 'webscraper', True, {
            'reason': 'circuit_breaker', 'failure_count': 5, 'last_error': 'boom',
        })
        metrics.add_metric.assert_called_once_with(name='CircuitBreakerScheduleDisableFailed', unit='Count', value=1)
        breaker_logger.exception.assert_called_once_with(
            f'Failed to disable the schedule for a tripped circuit breaker: {failure}')

    def test_an_unscheduled_plugin_records_the_trip_and_disables_nothing(self, table, trip_world):
        with patch.dict(os.environ):
            os.environ.pop('INGEST_SCHEDULE_RULE_NAME', None)
            _deployment_breaker('s3_import')._trip_breaker(5, 'boom')

        trip_world.get_events.assert_not_called()
        assert table.put_item.call_args.kwargs['Item']['pk'] == 'CIRCUIT#s3_import'
        trip_world.emit.assert_called_once()

    @pytest.mark.usefixtures('table', 'trip_world')
    def test_warns_which_plugin_it_disabled_after_how_many_failures(self, breaker_logger):
        _deployment_breaker()._trip_breaker(5, 'boom')

        breaker_logger.warning.assert_called_once_with('CIRCUIT BREAKER: Disabled webscraper after 5 failures')
        breaker_logger.exception.assert_not_called()


class TestRecordingASuccess:
    def test_a_failing_delete_is_logged_at_debug_with_its_cause_and_traceback(self, table, breaker_logger):
        table.delete_item.side_effect = THROTTLED

        assert _breaker().record_success() is None

        breaker_logger.debug.assert_called_once_with(
            f'Failed to clear circuit breaker state: {THROTTLED}', exc_info=True
        )


class TestAskingWhetherTheBreakerIsOpen:
    def test_a_failing_read_answers_closed_and_is_logged_at_debug_with_its_cause(
        self, table, breaker_logger
    ):
        table.get_item.side_effect = THROTTLED

        assert _breaker().is_open() is False

        breaker_logger.debug.assert_called_once_with(
            f'Failed to check circuit breaker state: {THROTTLED}', exc_info=True
        )
