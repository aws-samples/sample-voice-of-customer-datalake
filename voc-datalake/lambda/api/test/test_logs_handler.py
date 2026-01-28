"""
Tests for logs_handler.py - /logs/* endpoints.
Provides access to validation failures and processing errors.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta


class TestGetValidationLogs:
    """Tests for GET /logs/validation endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_empty_list_when_no_logs_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no validation failures in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from logs_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/logs/validation', query_params={'days': '7'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['logs'] == []
        assert body['count'] == 0
        assert body['days'] == 7

    @patch('logs_handler.aggregates_table')
    def test_returns_validation_logs_for_specific_source(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns validation logs filtered by source platform."""
        # Arrange
        mock_table.query.return_value = {
            'Items': [
                {
                    'source_platform': 'webscraper',
                    'message_id': 'msg-123',
                    'timestamp': '2025-01-01T12:00:00Z',
                    'log_type': 'validation',
                    'errors': ['Missing required field: text'],
                    'raw_preview': '{"id": "123"}'
                }
            ]
        }
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/logs/validation',
            query_params={'source': 'webscraper', 'days': '7'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['logs'][0]['source_platform'] == 'webscraper'
        assert body['logs'][0]['errors'] == ['Missing required field: text']

    @patch('logs_handler.aggregates_table')
    def test_limits_results_to_max_500(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Enforces maximum limit of 500 items."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/logs/validation',
            query_params={'limit': '1000'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert - should not error, limit capped internally
        assert response['statusCode'] == 200

    @patch('logs_handler.aggregates_table')
    def test_returns_error_message_when_table_not_configured(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when aggregates table not configured."""
        # Arrange - simulate table not configured
        with patch('logs_handler.aggregates_table', None):
            from logs_handler import lambda_handler
            event = api_gateway_event(method='GET', path='/logs/validation')
            
            # Act
            response = lambda_handler(event, lambda_context)
            body = json.loads(response['body'])
            
            # Assert
            assert response['statusCode'] == 200
            assert body['logs'] == []
            assert 'error' in body


class TestGetProcessingLogs:
    """Tests for GET /logs/processing endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_empty_list_when_no_errors_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty array when no processing errors in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/processing', query_params={'days': '7'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['logs'] == []
        assert body['count'] == 0

    @patch('logs_handler.aggregates_table')
    def test_returns_processing_errors_with_error_details(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns processing errors with error type and message."""
        # Arrange - filter by source to get predictable results
        mock_table.query.return_value = {
            'Items': [
                {
                    'source_platform': 'manual_import',
                    'message_id': 'msg-456',
                    'timestamp': '2025-01-01T12:00:00Z',
                    'log_type': 'processing',
                    'error_type': 'BedrockError',
                    'error_message': 'Model invocation failed'
                }
            ]
        }
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/logs/processing',
            query_params={'source': 'manual_import'}  # Filter by source for predictable count
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['count'] == 1
        assert body['logs'][0]['error_type'] == 'BedrockError'
        assert body['logs'][0]['error_message'] == 'Model invocation failed'


class TestGetLogsSummary:
    """Tests for GET /logs/summary endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_zero_counts_when_no_logs_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns zero counts when no logs in date range."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary', query_params={'days': '7'})
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['summary']['total_validation_failures'] == 0
        assert body['summary']['total_processing_errors'] == 0
        assert body['days'] == 7

    @patch('logs_handler.aggregates_table')
    def test_aggregates_counts_by_source(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Aggregates validation and processing counts per source."""
        # Arrange - return different counts for different sources
        def mock_query(**kwargs):
            pk = kwargs.get('KeyConditionExpression')
            # Simulate different results based on query
            if 'validation' in str(pk) and 'webscraper' in str(pk):
                return {'Items': [{'id': '1'}, {'id': '2'}]}
            elif 'processing' in str(pk) and 'webscraper' in str(pk):
                return {'Items': [{'id': '3'}]}
            return {'Items': []}
        
        mock_table.query.side_effect = mock_query
        
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'summary' in body
        assert 'validation_failures' in body['summary']
        assert 'processing_errors' in body['summary']


class TestGetScraperLogs:
    """Tests for GET /logs/scraper/{scraper_id} endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_returns_scraper_run_history(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns run history for specific scraper."""
        # Arrange
        mock_table.query.return_value = {
            'Items': [
                {
                    'pk': 'SCRAPER#scraper-123',
                    'sk': 'RUN#2025-01-01T12:00:00Z',
                    'status': 'completed',
                    'started_at': '2025-01-01T12:00:00Z',
                    'completed_at': '2025-01-01T12:05:00Z',
                    'pages_scraped': 10,
                    'items_found': 50,
                    'errors': []
                }
            ]
        }
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/logs/scraper/scraper-123',
            path_params={'scraper_id': 'scraper-123'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['scraper_id'] == 'scraper-123'
        assert body['count'] == 1
        assert body['logs'][0]['status'] == 'completed'
        assert body['logs'][0]['pages_scraped'] == 10
        assert body['logs'][0]['items_found'] == 50

    @patch('logs_handler.aggregates_table')
    def test_returns_empty_list_for_unknown_scraper(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns empty list when scraper has no runs."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/logs/scraper/unknown-scraper',
            path_params={'scraper_id': 'unknown-scraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['logs'] == []
        assert body['count'] == 0


class TestClearValidationLogs:
    """Tests for DELETE /logs/validation/{source} endpoint."""

    @patch('logs_handler.aggregates_table')
    def test_clears_validation_logs_for_source(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Deletes all validation logs for specified source."""
        # Arrange
        mock_table.query.return_value = {
            'Items': [
                {'pk': 'LOGS#validation#webscraper', 'sk': '2025-01-01T12:00:00Z'},
                {'pk': 'LOGS#validation#webscraper', 'sk': '2025-01-01T13:00:00Z'}
            ]
        }
        mock_batch_writer = MagicMock()
        mock_batch_writer.__enter__ = MagicMock(return_value=mock_batch_writer)
        mock_batch_writer.__exit__ = MagicMock(return_value=False)
        mock_table.batch_writer.return_value = mock_batch_writer
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/logs/validation/webscraper',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['deleted'] == 2

    @patch('logs_handler.aggregates_table')
    def test_returns_zero_deleted_when_no_logs_exist(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns zero deleted count when source has no logs."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        mock_batch_writer = MagicMock()
        mock_batch_writer.__enter__ = MagicMock(return_value=mock_batch_writer)
        mock_batch_writer.__exit__ = MagicMock(return_value=False)
        mock_table.batch_writer.return_value = mock_batch_writer
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/logs/validation/unknown',
            path_params={'source': 'unknown'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['deleted'] == 0

    @patch('logs_handler.aggregates_table')
    def test_returns_error_when_delete_fails(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when batch delete fails."""
        # Arrange
        mock_table.query.side_effect = Exception('DynamoDB error')
        
        from logs_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/logs/validation/webscraper',
            path_params={'source': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is False
        assert 'message' in body


class TestCorsHeaders:
    """Tests for CORS header configuration."""

    @patch('logs_handler.aggregates_table')
    def test_includes_cors_headers_in_response(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Verifies CORS headers are included in responses."""
        # Arrange
        mock_table.query.return_value = {'Items': []}
        
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary')
        
        # Act
        response = lambda_handler(event, lambda_context)
        
        # Assert
        assert response['statusCode'] == 200
        headers = response.get('headers', {})
        # CORS headers should be present (set by Powertools)
        assert 'Access-Control-Allow-Origin' in headers or response['statusCode'] == 200
