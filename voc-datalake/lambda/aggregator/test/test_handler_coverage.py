"""
Additional coverage tests for aggregator/handler.py.
Covers: DynamoDB format conversion branches (M, L, BOOL - lines 154-159).
"""
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestRecordHandlerDynamoDBFormats:
    """Cover DynamoDB format conversion branches in record_handler."""

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_handles_map_format(self, mock_process, mock_table):
        """Cover the 'M' (Map) branch in DynamoDB format conversion."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'category': {'S': 'product_quality'},
            'sentiment_label': {'S': 'positive'},
            'sentiment_score': {'N': '0.85'},
            'urgency': {'S': 'low'},
            'persona_name': {'S': 'Happy Customer'},
            'persona_attributes': {'M': {'segment': 'loyal'}},
        }

        result = record_handler(record)
        assert result['status'] == 'success'
        # Verify the M value was extracted
        call_args = mock_process.call_args[0][0]
        assert call_args['persona_attributes'] == {'segment': 'loyal'}

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_handles_list_format(self, mock_process, mock_table):
        """Cover the 'L' (List) branch in DynamoDB format conversion."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'tags': {'L': ['tag1', 'tag2']},
        }

        result = record_handler(record)
        assert result['status'] == 'success'
        call_args = mock_process.call_args[0][0]
        assert call_args['tags'] == ['tag1', 'tag2']

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_handles_bool_format(self, mock_process, mock_table):
        """Cover the 'BOOL' branch in DynamoDB format conversion."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'is_urgent': {'BOOL': True},
        }

        result = record_handler(record)
        assert result['status'] == 'success'
        call_args = mock_process.call_args[0][0]
        assert call_args['is_urgent'] is True

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_handles_already_deserialized_values(self, mock_process, mock_table):
        """Cover the 'else' branch for already deserialized values."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': '2025-01-15',  # Already deserialized string
            'source_platform': 'webscraper',
            'sentiment_score': Decimal('0.85'),  # Already deserialized Decimal
        }

        result = record_handler(record)
        assert result['status'] == 'success'
        call_args = mock_process.call_args[0][0]
        assert call_args['date'] == '2025-01-15'
