"""
Tests for aggregator/handler.py — DynamoDB format conversion branches.
Strengthened: assertions verify the converted values passed to process_new_feedback,
not just that status == 'success'.
"""
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestRecordHandlerDynamoDBFormats:
    """Tests that DynamoDB stream format types (M, L, BOOL, S, N) are correctly
    deserialized before being passed to process_new_feedback."""

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_deserializes_map_type_to_dict(self, mock_process, mock_table):
        """DynamoDB 'M' (Map) type is converted to a plain Python dict."""
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
            'persona_attributes': {'M': {'segment': 'loyal', 'age_range': '25-34'}},
        }

        record_handler(record)

        feedback = mock_process.call_args[0][0]
        assert feedback['persona_attributes'] == {'segment': 'loyal', 'age_range': '25-34'}
        assert feedback['source_platform'] == 'webscraper'
        assert feedback['sentiment_score'] == Decimal('0.85')

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_deserializes_list_type_to_python_list(self, mock_process, mock_table):
        """DynamoDB 'L' (List) type is converted to a plain Python list."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'tags': {'L': ['tag1', 'tag2', 'tag3']},
        }

        record_handler(record)

        feedback = mock_process.call_args[0][0]
        assert feedback['tags'] == ['tag1', 'tag2', 'tag3']

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_deserializes_bool_type_to_python_bool(self, mock_process, mock_table):
        """DynamoDB 'BOOL' type is converted to a Python bool."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': {'S': '2025-01-15'},
            'source_platform': {'S': 'webscraper'},
            'is_urgent': {'BOOL': True},
        }

        record_handler(record)

        feedback = mock_process.call_args[0][0]
        assert feedback['is_urgent'] is True

    @patch('aggregator.handler.aggregates_table')
    @patch('aggregator.handler.process_new_feedback')
    def test_passes_through_already_deserialized_values(self, mock_process, mock_table):
        """Values without DynamoDB type wrappers pass through unchanged."""
        from aggregator.handler import record_handler

        record = MagicMock()
        record.event_name = 'INSERT'
        record.dynamodb.new_image = {
            'date': '2025-01-15',
            'source_platform': 'webscraper',
            'sentiment_score': Decimal('0.85'),
        }

        record_handler(record)

        feedback = mock_process.call_args[0][0]
        assert feedback['date'] == '2025-01-15'
        assert feedback['sentiment_score'] == Decimal('0.85')
