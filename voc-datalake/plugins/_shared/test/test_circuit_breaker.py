"""Tests for circuit_breaker.py

The exact rows, query, audit event and log lines are pinned in
`test_circuit_breaker_mutation.py`; this file keeps the happy paths, the
"no table configured" short-circuits, and the workspace boundary: one breaker per
plugin AND workspace, and a trip that stops only that workspace's runs.
"""
import os
import re
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, SCOPE, WS

STACKS = Path(__file__).resolve().parents[3] / 'lib' / 'stacks'
TRIPPED = {'pk': f'WS#{WS}#CIRCUIT#test_plugin', 'sk': 'TRIPPED'}
#: Above every sort key the breaker writes (an open-ended range's top).
HIGHEST = chr(0xFFFF)


@pytest.fixture(autouse=True)
def aggregates_table_configured():
    """CDK hands every ingestor AGGREGATES_TABLE; plugins/conftest.py does not set it."""
    with patch('_shared.circuit_breaker.AGGREGATES_TABLE', 'test-aggregates'):
        yield


class TestCircuitBreakerIsOpen:
    """Tests for is_open() method."""

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_returns_false_when_no_tripped_state(self, mock_get_dynamo):
        """Returns False when circuit breaker has not been tripped."""
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No Item key
        mock_get_dynamo.return_value.Table.return_value = mock_table

        cb = CircuitBreaker('test_plugin', SCOPE)

        assert cb.is_open() is False
        mock_table.get_item.assert_called_once_with(Key=TRIPPED)

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_returns_true_when_tripped_state_exists(self, mock_get_dynamo):
        """Returns True when circuit breaker has been tripped."""
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_table.get_item.return_value = {'Item': {**TRIPPED, 'tripped_at': '2025-01-01T00:00:00Z'}}
        mock_get_dynamo.return_value.Table.return_value = mock_table

        cb = CircuitBreaker('test_plugin', SCOPE)

        assert cb.is_open() is True

    @patch('_shared.circuit_breaker.AGGREGATES_TABLE', '')
    def test_returns_false_when_table_not_configured(self):
        """Returns False when AGGREGATES_TABLE not set."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin', SCOPE)
        cb._table = None  # Force no table

        assert cb.is_open() is False


class TestCircuitBreakerRecordSuccess:
    """Tests for record_success() method."""

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_clears_tripped_state_on_success(self, mock_get_dynamo):
        """Deletes TRIPPED state when success recorded."""
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table

        cb = CircuitBreaker('test_plugin', SCOPE)
        cb.record_success()

        mock_table.delete_item.assert_called_once_with(Key=TRIPPED)

    @patch('_shared.circuit_breaker.AGGREGATES_TABLE', '')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_does_nothing_when_table_not_configured(self, mock_get_dynamo):
        """Silently returns when no table configured."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin', SCOPE)
        cb._table = None

        assert cb.record_success() is None
        mock_get_dynamo.assert_not_called()
        assert cb._table is None


class TestCircuitBreakerRecordFailure:
    """Tests for record_failure() method."""

    @patch('_shared.circuit_breaker.AGGREGATES_TABLE', '')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.logger')
    def test_logs_warning_when_table_not_configured(self, mock_logger, mock_get_dynamo):
        """Logs warning when AGGREGATES_TABLE not set."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin', SCOPE)
        cb._table = None

        cb.record_failure('Some error')

        mock_logger.warning.assert_called_once_with(
            "AGGREGATES_TABLE not configured, circuit breaker disabled"
        )
        mock_get_dynamo.assert_not_called()


class TestATripStopsOnlyThatWorkspace:
    """The plugin's one EventBridge rule serves every workspace (the tick fans out), so a workspace's trip must
    never disable it: one workspace's failing credentials would stop every other workspace's ingestion. The trip
    is the workspace's TRIPPED row, which its own runs check (``is_open``)."""

    @patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': 'voc-ingest-webscraper-schedule'})
    @patch('_shared.audit.emit_audit_event')
    @patch('_shared.circuit_breaker.get_eventbridge_client')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_a_trip_writes_the_workspaces_row_and_disables_no_rule_even_with_one_named(
        self, mock_get_dynamo, mock_events, mock_emit
    ):
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table

        CircuitBreaker('webscraper', SCOPE)._trip_breaker(5, 'boom')

        mock_events.assert_not_called()
        assert mock_table.put_item.call_args.kwargs['Item']['pk'] == f'WS#{WS}#CIRCUIT#webscraper'
        mock_emit.assert_called_once()
        assert mock_emit.call_args.args[3]['workspace_id'] == WS


class TestTheDeploymentWideBreakerIsUnchanged:
    """A run whose event names no workspace keeps the breaker it always had (until phase 2's last slice): the
    deployment-wide rows, which the integrations API reads and resets, and the schedule disable on a trip."""

    RULE = 'voc-ingest-webscraper-schedule-123456789012-us-east-1'

    @patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': RULE})
    @patch('_shared.audit.emit_audit_event')
    @patch('shared.aws._eventbridge_client', None)
    @patch('shared.aws.boto3.client')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_a_trip_writes_the_api_s_row_and_disables_the_rule_cdk_named(
        self, mock_get_dynamo, mock_boto_client, mock_emit
    ):
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table

        CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        mock_boto_client.assert_called_once_with('events')
        mock_boto_client.return_value.disable_rule.assert_called_once_with(Name=self.RULE)
        assert mock_table.put_item.call_args.kwargs['Item']['pk'] == 'CIRCUIT#webscraper'
        mock_emit.assert_called_once_with('plugin.disabled', 'webscraper', True, {
            'reason': 'circuit_breaker', 'failure_count': 5, 'last_error': 'boom'})

    def test_its_rows_are_the_deployment_wide_ones(self, real_aggregates_table):
        from _shared.circuit_breaker import CircuitBreaker

        breaker = CircuitBreaker('webscraper')
        for attempt in range(3):
            breaker.record_failure(f'boom {attempt}')

        assert breaker.is_open() is True
        assert {item['pk'] for item in real_aggregates_table.items.values()} == {
            'FAILURES#webscraper', 'CIRCUIT#webscraper'}
        breaker.record_success()
        assert breaker.is_open() is False

    @pytest.mark.usefixtures('real_aggregates_table')
    def test_a_workspace_trip_leaves_the_deployment_wide_breaker_closed(self):
        from _shared.circuit_breaker import CircuitBreaker

        for attempt in range(3):
            CircuitBreaker('webscraper', SCOPE).record_failure(f'boom {attempt}')

        assert CircuitBreaker('webscraper').is_open() is False


def _validation_error(operation: str, message: str) -> ClientError:
    return ClientError({'Error': {'Code': 'ValidationException', 'Message': message}}, operation)


class _KeyedTable:
    """An in-memory DynamoDB table that, like the real one, rejects a key or a
    key condition that does not name exactly its key schema. (plugins/conftest.py
    refuses moto: its calls route through the same guarded seam.)"""

    def __init__(self, hash_key: str, range_key: str | None = None):
        self.key_names = {hash_key} | ({range_key} if range_key else set())
        self.hash_key, self.range_key = hash_key, range_key
        self.items: dict[tuple, dict] = {}

    def _key(self, key: dict) -> tuple:
        if set(key) != self.key_names:
            raise _validation_error('GetItem', 'The provided key element does not match the schema')
        return tuple(key[name] for name in sorted(self.key_names))

    def put_item(self, Item: dict):
        self.items[self._key({k: Item[k] for k in self.key_names if k in Item})] = dict(Item)

    def get_item(self, Key: dict):
        found = self.items.get(self._key(Key))
        return {'Item': found} if found else {}

    def delete_item(self, Key: dict):
        self.items.pop(self._key(Key), None)

    def query(self, KeyConditionExpression: str, ExpressionAttributeValues: dict,
              ExpressionAttributeNames: dict | None = None):
        names = ExpressionAttributeNames or {}
        hash_name, _, rest = KeyConditionExpression.partition(' = :p')
        if names.get(hash_name, hash_name) != self.hash_key:
            raise _validation_error('Query', 'Query condition missed key schema element')
        if rest and not rest.startswith(f' AND {self.range_key} BETWEEN :start AND :end'):
            raise _validation_error('Query', 'Query condition missed key schema element')
        start, end = ExpressionAttributeValues.get(':start', ''), ExpressionAttributeValues.get(':end', HIGHEST)
        return {'Items': [
            item for item in self.items.values()
            if item[self.hash_key] == ExpressionAttributeValues[':p'] and start <= item[self.range_key] <= end
        ]}


@pytest.fixture
def real_aggregates_table():
    """The aggregates table with its deployed key schema (pk/sk)."""
    table = _KeyedTable('pk', 'sk')
    with (
        patch('_shared.circuit_breaker.get_dynamodb_resource') as get_dynamo,
        patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3),
        patch('_shared.audit.emit_audit_event'),
    ):
        get_dynamo.return_value.Table.return_value = table
        yield table


class TestTheBreakerWorksAgainstTheDeployedSchema:
    """Regression: the breaker addressed the WATERMARKS table (key `source` only)
    with `pk`/`sk`, so every query/get/delete was a ValidationException and a
    deployed breaker never counted a failure or tripped. Every double in the
    other tests accepted any key, which is how it went unnoticed."""

    def test_the_old_watermarks_schema_would_have_refused_every_breaker_read(self):
        watermarks = _KeyedTable('source')

        with pytest.raises(ClientError):
            watermarks.get_item(Key=TRIPPED)

    def test_the_breaker_reads_the_aggregates_table_variable_not_the_watermarks_one(self):
        from _shared import circuit_breaker

        assert not hasattr(circuit_breaker, 'WATERMARKS_TABLE')
        assert hasattr(circuit_breaker, 'AGGREGATES_TABLE')

    def test_every_ingestor_is_handed_the_aggregates_table(self):
        source = (STACKS / 'ingestion-stack.ts').read_text()

        assert re.search(r'lambdaEnv\.AGGREGATES_TABLE = aggregatesTable\.tableName', source)

    def test_the_aggregates_table_keeps_the_pk_sk_keys_and_the_ttl_attribute(self):
        source = (STACKS / 'core-stack.ts').read_text()
        aggregates = source[source.index("'AggregatesTable'"):]
        aggregates = aggregates[:aggregates.index('});')]

        assert 'keys:' not in aggregates  # default pk/sk pair (createEncryptedTable)
        assert "timeToLiveAttribute: 'ttl'" in aggregates

    def test_threshold_failures_trip_it_and_a_success_closes_it(self, real_aggregates_table):
        from _shared.circuit_breaker import CircuitBreaker

        breaker = CircuitBreaker('webscraper', SCOPE)
        for attempt in range(3):
            breaker.record_failure(f'boom {attempt}')

        assert breaker.is_open() is True
        row = real_aggregates_table.get_item(Key={'pk': f'WS#{WS}#CIRCUIT#webscraper', 'sk': 'TRIPPED'})['Item']
        assert row['failure_count'] == 3
        assert row['last_error'] == 'boom 2'

        breaker.record_success()

        assert breaker.is_open() is False

    def test_two_failures_under_a_threshold_of_three_leave_it_closed(self, real_aggregates_table):
        from _shared.circuit_breaker import CircuitBreaker

        breaker = CircuitBreaker('webscraper', SCOPE)
        breaker.record_failure('one')
        breaker.record_failure('two')

        assert breaker.is_open() is False
        failures = real_aggregates_table.query(
            KeyConditionExpression='#p = :p', ExpressionAttributeNames={'#p': 'pk'},
            ExpressionAttributeValues={':p': f'WS#{WS}#FAILURES#webscraper'},
        )['Items']
        assert len(failures) == 2

    def test_one_workspaces_trip_leaves_another_workspaces_breaker_closed(self, real_aggregates_table):
        from _shared.circuit_breaker import CircuitBreaker

        tripped = CircuitBreaker('webscraper', SCOPE)
        for attempt in range(3):
            tripped.record_failure(f'boom {attempt}')
        other = CircuitBreaker('webscraper', OTHER_SCOPE)
        other.record_failure('one')

        assert tripped.is_open() is True
        assert other.is_open() is False
        # The other workspace's single failure did not count towards this one's window, nor the reverse.
        assert {item['pk'] for item in real_aggregates_table.items.values()} == {
            f'WS#{WS}#FAILURES#webscraper', f'WS#{WS}#CIRCUIT#webscraper', f'WS#{OTHER_WS}#FAILURES#webscraper'}
