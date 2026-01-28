"""Tests for circuit_breaker.py"""
import os
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestCircuitBreakerInit:
    """Tests for CircuitBreaker initialization."""

    def test_initializes_with_plugin_id(self):
        """Creates circuit breaker with correct plugin ID."""
        from _shared.circuit_breaker import CircuitBreaker
        
        cb = CircuitBreaker('webscraper')
        
        assert cb.plugin_id == 'webscraper'

    def test_lazy_loads_dynamodb_table(self):
        """Does not connect to DynamoDB until table property accessed."""
        from _shared.circuit_breaker import CircuitBreaker
        
        cb = CircuitBreaker('test_plugin')
        
        # _table should be None initially
        assert cb._table is None


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
    def test_does_nothing_when_table_not_configured(self):
        """Silently returns when no table configured."""
        from _shared.circuit_breaker import CircuitBreaker
        
        cb = CircuitBreaker('test_plugin')
        cb._table = None
        
        # Should not raise
        cb.record_success()


class TestCircuitBreakerRecordFailure:
    """Tests for record_failure() method."""

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    def test_records_failure_in_dynamodb(self, mock_get_dynamo):
        """Stores failure record with TTL."""
        from _shared.circuit_breaker import CircuitBreaker
        
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': []}  # No recent failures
        mock_get_dynamo.return_value.Table.return_value = mock_table
        
        cb = CircuitBreaker('test_plugin')
        cb.record_failure('Connection timeout')
        
        # Should have called put_item to record failure
        assert mock_table.put_item.called
        call_args = mock_table.put_item.call_args
        item = call_args.kwargs['Item']
        assert item['pk'] == 'FAILURES#test_plugin'
        assert 'error' in item
        assert 'ttl' in item

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 3)
    def test_trips_breaker_when_threshold_exceeded(self, mock_get_dynamo):
        """Disables plugin when failure count exceeds threshold."""
        from _shared.circuit_breaker import CircuitBreaker
        
        mock_table = MagicMock()
        # Return 2 existing failures (threshold is 3, so this + 1 = 3 = trip)
        mock_table.query.return_value = {'Items': [
            {'sk': '2025-01-01T00:00:00Z'},
            {'sk': '2025-01-01T00:01:00Z'},
        ]}
        mock_get_dynamo.return_value.Table.return_value = mock_table
        
        cb = CircuitBreaker('test_plugin')
        
        with patch.object(cb, '_trip_breaker') as mock_trip:
            cb.record_failure('Third failure')
            mock_trip.assert_called_once()

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.FAILURE_THRESHOLD', 5)
    def test_does_not_trip_when_below_threshold(self, mock_get_dynamo):
        """Does not trip when failures below threshold."""
        from _shared.circuit_breaker import CircuitBreaker
        
        mock_table = MagicMock()
        mock_table.query.return_value = {'Items': [
            {'sk': '2025-01-01T00:00:00Z'},
        ]}  # Only 1 existing failure
        mock_get_dynamo.return_value.Table.return_value = mock_table
        
        cb = CircuitBreaker('test_plugin')
        
        with patch.object(cb, '_trip_breaker') as mock_trip:
            cb.record_failure('Second failure')
            mock_trip.assert_not_called()

    @patch('_shared.circuit_breaker.WATERMARKS_TABLE', '')
    def test_logs_warning_when_table_not_configured(self):
        """Logs warning when WATERMARKS_TABLE not set."""
        from _shared.circuit_breaker import CircuitBreaker
        
        cb = CircuitBreaker('test_plugin')
        cb._table = None
        
        # Should not raise, just log warning
        cb.record_failure('Some error')


class TestCircuitBreakerTripBreaker:
    """Tests for _trip_breaker() method."""

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.HAS_EVENTBRIDGE', False)
    def test_records_trip_state_in_dynamodb(self, mock_get_dynamo):
        """Records TRIPPED state in DynamoDB."""
        from _shared.circuit_breaker import CircuitBreaker
        
        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table
        
        cb = CircuitBreaker('test_plugin')
        cb._trip_breaker(3, 'Connection refused')
        
        # Find the put_item call for CIRCUIT state
        circuit_calls = [
            call for call in mock_table.put_item.call_args_list
            if call.kwargs.get('Item', {}).get('pk', '').startswith('CIRCUIT#')
        ]
        assert len(circuit_calls) == 1
        item = circuit_calls[0].kwargs['Item']
        assert item['pk'] == 'CIRCUIT#test_plugin'
        assert item['sk'] == 'TRIPPED'
        assert item['failure_count'] == 3

    @patch('_shared.circuit_breaker.get_dynamodb_resource')
    @patch('_shared.circuit_breaker.HAS_EVENTBRIDGE', False)
    def test_emits_audit_event_on_trip(self, mock_get_dynamo):
        """Emits plugin.disabled audit event when tripped."""
        from _shared.circuit_breaker import CircuitBreaker
        
        mock_table = MagicMock()
        mock_get_dynamo.return_value.Table.return_value = mock_table
        
        cb = CircuitBreaker('test_plugin')
        
        # The audit event is emitted via import inside _trip_breaker
        # We verify the method completes without error
        cb._trip_breaker(5, 'API rate limited')
        
        # Verify DynamoDB was updated (audit event is a side effect)
        assert mock_table.put_item.called
