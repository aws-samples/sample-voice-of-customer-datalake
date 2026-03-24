"""
Additional coverage tests for logs_handler.py.
Covers: validation/processing logs without source (all-sources path),
scraper logs error/no-table paths, summary error/no-table paths,
clear logs no-table path, processing logs error path.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestGetValidationLogsAllSources:
    """Cover the all-sources path (no source param) with actual data."""

    @patch('logs_handler.aggregates_table')
    def test_aggregates_logs_from_all_sources(self, mock_table, api_gateway_event, lambda_context):
        """Cover the else branch that queries all known sources and sorts."""
        # Return items on first call (webscraper), empty on rest
        mock_table.query.side_effect = [
            {'Items': [
                {'source_platform': 'webscraper', 'timestamp': '2025-01-02T00:00:00Z', 'log_type': 'validation', 'errors': ['err1']},
            ]},
            {'Items': [
                {'source_platform': 'manual_import', 'timestamp': '2025-01-03T00:00:00Z', 'log_type': 'validation', 'errors': ['err2']},
            ]},
            {'Items': []},  # s3_import
        ]
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/validation', query_params={'days': '7'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] == 2
        # Should be sorted by timestamp descending
        assert body['logs'][0]['timestamp'] > body['logs'][1]['timestamp']

    @patch('logs_handler.aggregates_table')
    def test_returns_error_on_query_failure(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.side_effect = Exception('DynamoDB error')
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/validation', query_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetProcessingLogsAllSources:
    """Cover the all-sources path for processing logs."""

    @patch('logs_handler.aggregates_table')
    def test_aggregates_processing_logs_from_all_sources(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.side_effect = [
            {'Items': [
                {'source_platform': 'webscraper', 'timestamp': '2025-01-01T00:00:00Z', 'log_type': 'processing', 'error_type': 'E1', 'error_message': 'msg1'},
            ]},
            {'Items': []},  # manual_import
            {'Items': []},  # s3_import
        ]
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/processing', query_params={'days': '7'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['count'] >= 1

    @patch('logs_handler.aggregates_table')
    def test_returns_error_on_query_failure(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.side_effect = Exception('DynamoDB error')
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/processing', query_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('logs_handler.aggregates_table', None)
    def test_raises_config_error_when_no_table(self, api_gateway_event, lambda_context):
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/processing')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetScraperLogsEdgeCases:
    """Cover scraper logs error and no-table paths."""

    @patch('logs_handler.aggregates_table', None)
    def test_raises_config_error_when_no_table(self, api_gateway_event, lambda_context):
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/scraper/x', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('logs_handler.aggregates_table')
    def test_returns_error_on_query_failure(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.side_effect = Exception('DynamoDB error')
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/scraper/x', path_params={'scraper_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetLogsSummaryEdgeCases:
    """Cover summary error and no-table paths."""

    @patch('logs_handler.aggregates_table', None)
    def test_raises_config_error_when_no_table(self, api_gateway_event, lambda_context):
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('logs_handler.aggregates_table')
    def test_returns_error_on_query_failure(self, mock_table, api_gateway_event, lambda_context):
        mock_table.query.side_effect = Exception('DynamoDB error')
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('logs_handler.aggregates_table')
    def test_returns_nonzero_counts_when_logs_exist(self, mock_table, api_gateway_event, lambda_context):
        """Cover lines 207-208, 211-212: summary with actual validation/processing data."""
        mock_table.query.side_effect = [
            # validation webscraper
            {'Items': [{'id': '1'}, {'id': '2'}]},
            # processing webscraper
            {'Items': [{'id': '3'}]},
            # validation manual_import
            {'Items': []},
            # processing manual_import
            {'Items': [{'id': '4'}, {'id': '5'}]},
            # validation s3_import
            {'Items': []},
            # processing s3_import
            {'Items': []},
        ]
        from logs_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/logs/summary', query_params={'days': '7'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['summary']['total_validation_failures'] == 2
        assert body['summary']['total_processing_errors'] == 3
        assert body['summary']['validation_failures']['webscraper'] == 2
        assert body['summary']['processing_errors']['manual_import'] == 2


class TestClearValidationLogsEdgeCases:
    """Cover clear logs no-table path."""

    @patch('logs_handler.aggregates_table', None)
    def test_raises_config_error_when_no_table(self, api_gateway_event, lambda_context):
        from logs_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/logs/validation/webscraper', path_params={'source': 'webscraper'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
