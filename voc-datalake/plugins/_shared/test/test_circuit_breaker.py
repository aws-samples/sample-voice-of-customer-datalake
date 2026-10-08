"""Tests for circuit_breaker.py

The exact rows, query, audit event and log lines are pinned in
`test_circuit_breaker_mutation.py`; this file keeps the happy paths and the
"no table configured" short-circuits.
"""
import os
from unittest.mock import MagicMock, patch


class TestCircuitBreakerIsOpen:
    """Tests for is_open() method."""

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_returns_false_when_no_tripped_state(self, mock_get_dynamo):
        """Returns False when circuit breaker has not been tripped."""
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No Item key
        mock_get_dynamo.return_value.Table.return_value = mock_table

        cb = CircuitBreaker('test_plugin')

        assert cb.is_open() is False
        mock_table.get_item.assert_called_once_with(
            Key={'pk': 'CIRCUIT#test_plugin', 'sk': 'TRIPPED'}
        )

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_returns_true_when_tripped_state_exists(self, mock_get_dynamo):
        """Returns True when circuit breaker has been tripped."""
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {
                'pk': 'CIRCUIT#test_plugin',
                'sk': 'TRIPPED',
                'tripped_at': '2025-01-01T00:00:00Z'
            }
        }
        mock_get_dynamo.return_value.Table.return_value = mock_table

        cb = CircuitBreaker('test_plugin')

        assert cb.is_open() is True

    @patch('_shared.circuit_breaker.WATERMARKS_TABLE', '')
    def test_returns_false_when_table_not_configured(self):
        """Returns False when WATERMARKS_TABLE not set."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin')
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

        cb = CircuitBreaker('test_plugin')
        cb.record_success()

        mock_table.delete_item.assert_called_once_with(
            Key={'pk': 'CIRCUIT#test_plugin', 'sk': 'TRIPPED'}
        )

    @patch('_shared.circuit_breaker.WATERMARKS_TABLE', '')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_does_nothing_when_table_not_configured(self, mock_get_dynamo):
        """Silently returns when no table configured."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin')
        cb._table = None

        assert cb.record_success() is None
        mock_get_dynamo.assert_not_called()
        assert cb._table is None


class TestCircuitBreakerRecordFailure:
    """Tests for record_failure() method."""

    @patch('_shared.circuit_breaker.WATERMARKS_TABLE', '')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.logger')
    def test_logs_warning_when_table_not_configured(self, mock_logger, mock_get_dynamo):
        """Logs warning when WATERMARKS_TABLE not set."""
        from _shared.circuit_breaker import CircuitBreaker

        cb = CircuitBreaker('test_plugin')
        cb._table = None

        cb.record_failure('Some error')

        mock_logger.warning.assert_called_once_with(
            "WATERMARKS_TABLE not configured, circuit breaker disabled"
        )
        mock_get_dynamo.assert_not_called()


class TestTrippingDisablesTheSchedule:
    """The regression this breaker shipped with: it never disabled anything.

    It looked for `shared.aws.get_eventbridge_client`, which did not exist, so
    a trip wrote the CIRCUIT row and skipped DisableRule — every later run
    stopped at `is_open` while the schedule kept invoking the ingestor. Only
    `boto3.client` is doubled here, so the real factory and the real call path
    from `_trip_breaker` to `disable_rule` are what is exercised.
    """

    RULE = 'voc-ingest-webscraper-schedule-123456789012-us-east-1'

    @patch.dict(os.environ, {'INGEST_SCHEDULE_RULE_NAME': RULE})
    @patch('_shared.audit.emit_audit_event')
    @patch('shared.aws._eventbridge_client', None)
    @patch('shared.aws.boto3.client')
    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_a_trip_disables_the_rule_cdk_named_through_the_shared_factory(
        self, mock_get_dynamo, mock_boto_client, mock_emit
    ):
        from _shared.circuit_breaker import CircuitBreaker

        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table

        CircuitBreaker('webscraper')._trip_breaker(5, 'boom')

        mock_boto_client.assert_called_once_with('events')
        mock_boto_client.return_value.disable_rule.assert_called_once_with(Name=self.RULE)
        assert mock_table.put_item.call_args.kwargs['Item']['pk'] == 'CIRCUIT#webscraper'
        mock_emit.assert_called_once()
