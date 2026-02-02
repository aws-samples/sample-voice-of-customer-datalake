"""
Tests for manual_import_handler.py - /scrapers/manual/* endpoints.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestExtractSourceFromUrl:
    """Tests for extract_source_from_url helper function."""

    def test_extracts_g2_from_url(self):
        """Extracts g2 source from g2.com URL."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from manual_import_handler import extract_source_from_url
        
        assert extract_source_from_url('https://www.g2.com/products/example') == 'g2'
        assert extract_source_from_url('https://g2.com/products/example') == 'g2'

    def test_extracts_capterra_from_url(self):
        """Extracts capterra source from capterra.com URL."""
        from manual_import_handler import extract_source_from_url
        
        assert extract_source_from_url('https://www.capterra.com/p/12345/product') == 'capterra'
        assert extract_source_from_url('https://capterra.com/reviews/12345') == 'capterra'

    def test_returns_sanitized_domain_for_unknown_source(self):
        """Returns sanitized domain for unknown sources."""
        from manual_import_handler import extract_source_from_url
        
        assert extract_source_from_url('https://www.example.com/reviews') == 'example.com'
        assert extract_source_from_url('https://custom-reviews.io/page') == 'custom-reviews.io'

    def test_returns_unknown_for_invalid_url(self):
        """Returns 'unknown' for invalid URLs."""
        from manual_import_handler import extract_source_from_url
        
        assert extract_source_from_url('not-a-url') == 'unknown'
        assert extract_source_from_url('') == 'unknown'
        assert extract_source_from_url('ftp://example.com') == 'example.com'  # Valid URL, unknown source


class TestStartParseEndpoint:
    """Tests for POST /scrapers/manual/parse endpoint."""

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_source_url_missing(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Returns error when source_url is not provided."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={'raw_text': 'Some review text'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Source URL is required' in body['message']

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_raw_text_missing(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Returns error when raw_text is not provided."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={'source_url': 'https://g2.com/review/example'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Raw text is required' in body['message']

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_text_exceeds_max_characters(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Returns error when raw_text exceeds maximum character limit."""
        from manual_import_handler import lambda_handler, MAX_CHARACTERS
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'x' * (MAX_CHARACTERS + 1)
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'exceeds maximum' in body['message']

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_creates_job_and_invokes_processor(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Creates job record and invokes async processor."""
        mock_lambda = MagicMock()
        mock_boto_client.return_value = mock_lambda
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'Great product! 5 stars.'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'job_id' in body
        assert body['source_origin'] == 'g2'
        mock_table.put_item.assert_called_once()
        mock_lambda.invoke.assert_called_once()


class TestGetParseStatusEndpoint:
    """Tests for GET /scrapers/manual/parse/<job_id> endpoint."""

    @patch('manual_import_handler.aggregates_table')
    def test_returns_not_found_for_missing_job(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns not_found status when job doesn't exist."""
        mock_table.get_item.return_value = {}
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/nonexistent-job',
            path_params={'job_id': 'nonexistent-job'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'not_found'

    @patch('manual_import_handler.aggregates_table')
    def test_returns_processing_status(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns processing status for in-progress job."""
        mock_table.get_item.return_value = {
            'Item': {
                'status': 'processing',
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example'
            }
        }
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'processing'
        assert body['source_origin'] == 'g2'

    @patch('manual_import_handler.aggregates_table')
    def test_returns_completed_status_with_reviews(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns completed status with parsed reviews."""
        mock_table.get_item.return_value = {
            'Item': {
                'status': 'completed',
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example',
                'reviews': [
                    {'text': 'Great product!', 'rating': 5, 'author': 'John'}
                ],
                'unparsed_sections': []
            }
        }
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'completed'
        assert len(body['reviews']) == 1
        assert body['reviews'][0]['text'] == 'Great product!'

    @patch('manual_import_handler.aggregates_table')
    def test_returns_failed_status_with_error(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns failed status with error message."""
        mock_table.get_item.return_value = {
            'Item': {
                'status': 'failed',
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example',
                'error': 'LLM parsing failed'
            }
        }
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'failed'
        assert body['error'] == 'LLM parsing failed'


class TestConfirmImportEndpoint:
    """Tests for POST /scrapers/manual/confirm endpoint."""

    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_job_id_missing(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when job_id is not provided."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={'reviews': [{'text': 'Great!'}]}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Job ID is required' in body['message']

    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_reviews_empty(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when no reviews provided."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={'job_id': 'job-123', 'reviews': []}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'No reviews to import' in body['message']

    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_returns_error_when_job_not_found(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns error when job doesn't exist."""
        mock_table.get_item.return_value = {}
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'nonexistent-job',
                'reviews': [{'text': 'Great!', 'date': '2026-01-10'}]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Job not found' in body['message']

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_imports_reviews_successfully(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Successfully imports reviews to SQS and S3."""
        mock_table.get_item.return_value = {
            'Item': {
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'Original raw text',
                'reviews': [{'text': 'Great!', 'rating': 5}]
            }
        }
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'job-123',
                'reviews': [
                    {'text': 'Great product!', 'rating': 5, 'author': 'John', 'date': '2026-01-10'},
                    {'text': 'Good service', 'rating': 4, 'author': 'Jane', 'date': '2026-01-09'}
                ]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['imported_count'] == 2
        assert mock_sqs.send_message.call_count == 2
        mock_s3.put_object.assert_called_once()
        mock_table.update_item.assert_called_once()


class TestStartParseEndpointAdditional:
    """Additional tests for POST /scrapers/manual/parse endpoint."""

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_handles_lambda_invoke_failure(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Handles Lambda invoke failure gracefully."""
        mock_lambda = MagicMock()
        mock_lambda.invoke.side_effect = Exception('Lambda invoke failed')
        mock_boto_client.return_value = mock_lambda
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'Great product! 5 stars.'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Failed to start processing' in body['message']
        # Verify job status was updated to failed
        mock_table.update_item.assert_called_once()

    @patch('manual_import_handler.boto3.client')
    @patch('manual_import_handler.aggregates_table')
    def test_trims_whitespace_from_inputs(
        self, mock_table, mock_boto_client, api_gateway_event, lambda_context
    ):
        """Trims whitespace from source_url and raw_text."""
        mock_lambda = MagicMock()
        mock_boto_client.return_value = mock_lambda
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/parse',
            body={
                'source_url': '  https://g2.com/review/example  ',
                'raw_text': '  Great product!  '
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        # Verify the put_item was called with trimmed values
        call_args = mock_table.put_item.call_args
        item = call_args[1]['Item']
        assert item['source_url'] == 'https://g2.com/review/example'
        assert item['raw_text'] == 'Great product!'


class TestGetParseStatusEndpointAdditional:
    """Additional tests for GET /scrapers/manual/parse/<job_id> endpoint."""

    @patch('manual_import_handler.aggregates_table')
    def test_handles_dynamodb_exception(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Handles DynamoDB exception gracefully."""
        mock_table.get_item.side_effect = Exception('DynamoDB error')
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'error'
        assert 'Failed to retrieve job status' in body['error']

    @patch('manual_import_handler.aggregates_table', None)
    def test_returns_error_when_table_not_configured(
        self, api_gateway_event, lambda_context
    ):
        """Returns error when aggregates table is not configured."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/scrapers/manual/parse/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['status'] == 'error'
        assert 'Table not configured' in body['error']


class TestConfirmImportEndpointAdditional:
    """Additional tests for POST /scrapers/manual/confirm endpoint."""

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_handles_s3_upload_failure(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Continues import even if S3 upload fails."""
        mock_table.get_item.return_value = {
            'Item': {
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'Original raw text',
                'reviews': []
            }
        }
        mock_s3.put_object.side_effect = Exception('S3 upload failed')
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'job-123',
                'reviews': [{'text': 'Great product!', 'rating': 5, 'date': '2026-01-10'}]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Should still succeed even if S3 fails
        assert body['success'] is True
        assert body['imported_count'] == 1

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_handles_sqs_send_failure(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Reports errors when SQS send fails for some reviews."""
        mock_table.get_item.return_value = {
            'Item': {
                'source_origin': 'g2',
                'source_url': 'https://g2.com/review/example',
                'raw_text': 'Original raw text',
                'reviews': []
            }
        }
        # First call succeeds, second fails
        mock_sqs.send_message.side_effect = [None, Exception('SQS error')]
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'job-123',
                'reviews': [
                    {'text': 'Great product!', 'rating': 5, 'date': '2026-01-10'},
                    {'text': 'Good service', 'rating': 4, 'date': '2026-01-09'}
                ]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['imported_count'] == 1
        assert 'errors' in body
        assert len(body['errors']) == 1

    @patch('manual_import_handler.aggregates_table', None)
    def test_returns_error_when_table_not_configured(
        self, api_gateway_event, lambda_context
    ):
        """Returns error when aggregates table is not configured."""
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'job-123',
                'reviews': [{'text': 'Great!', 'date': '2026-01-10'}]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Table not configured' in body['message']

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/queue')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    @patch('manual_import_handler.aggregates_table')
    def test_handles_general_exception(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Handles general exception during import."""
        mock_table.get_item.side_effect = Exception('Unexpected error')
        
        from manual_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/scrapers/manual/confirm',
            body={
                'job_id': 'job-123',
                'reviews': [{'text': 'Great!', 'date': '2026-01-10'}]
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is False
        assert 'Failed to import reviews' in body['message']


class TestDecimalDefault:
    """Tests for decimal_default JSON serializer."""

    def test_converts_decimal_to_float(self):
        """Converts Decimal to float for JSON serialization."""
        from decimal import Decimal
        from shared.api import decimal_default
        
        assert decimal_default(Decimal('3.14')) == 3.14
        assert decimal_default(Decimal('100')) == 100.0

    def test_raises_type_error_for_non_decimal(self):
        """Raises TypeError for non-Decimal types."""
        from shared.api import decimal_default
        
        with pytest.raises(TypeError):
            decimal_default({'key': 'value'})
