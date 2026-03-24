"""
Additional coverage tests for manual_import_handler.py.
Covers json_upload endpoint (lines 357-464), confirm_import edge cases,
and start_parse configuration errors.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestStartParseConfigErrors:
    """Cover ConfigurationError branches in start_parse."""

    @patch('manual_import_handler.aggregates_table', None)
    def test_returns_error_when_aggregates_table_not_configured(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/parse',
            body={'source_url': 'https://g2.com/r', 'raw_text': 'text'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('manual_import_handler.MANUAL_IMPORT_PROCESSOR_FUNCTION', '')
    @patch('manual_import_handler.aggregates_table', MagicMock())
    def test_returns_error_when_processor_function_not_configured(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/parse',
            body={'source_url': 'https://g2.com/r', 'raw_text': 'text'}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestConfirmImportDateValidation:
    """Cover date validation branches in confirm_import."""

    def test_returns_error_when_single_review_missing_date(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/confirm',
            body={'job_id': 'j1', 'reviews': [{'text': 'Good', 'date': None}]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'Review 1 is missing a date' in body['error']

    def test_returns_error_when_multiple_reviews_missing_dates(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/confirm',
            body={'job_id': 'j1', 'reviews': [
                {'text': 'A', 'date': '2026-01-01'},
                {'text': 'B'},
                {'text': 'C'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'Reviews 2, 3 are missing dates' in body['error']


class TestConfirmImportUserExtraction:
    """Cover user_id extraction from request context."""

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.aggregates_table')
    def test_extracts_user_from_cognito_claims(self, mock_table, mock_sqs, api_gateway_event, lambda_context):
        mock_table.get_item.return_value = {
            'Item': {'source_origin': 'g2', 'source_url': 'https://g2.com', 'raw_text': 't', 'reviews': []}
        }
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/confirm',
            body={'job_id': 'j1', 'reviews': [{'text': 'Good', 'date': '2026-01-01'}]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', '')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.aggregates_table')
    def test_skips_sqs_when_queue_url_empty(self, mock_table, mock_sqs, api_gateway_event, lambda_context):
        """When PROCESSING_QUEUE_URL is empty, reviews are counted but not sent to SQS."""
        mock_table.get_item.return_value = {
            'Item': {'source_origin': 'g2', 'source_url': 'https://g2.com', 'raw_text': 't', 'reviews': []}
        }
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/confirm',
            body={'job_id': 'j1', 'reviews': [{'text': 'Good', 'date': '2026-01-01'}]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['imported_count'] == 1
        mock_sqs.send_message.assert_not_called()


class TestJsonUploadEndpoint:
    """Cover POST /scrapers/manual/json-upload endpoint (lines 357-464)."""

    def test_returns_error_when_items_not_list(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': 'not-a-list'}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'non-empty' in body['error']

    def test_returns_error_when_items_empty(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': []}
        )
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('manual_import_handler.MAX_JSON_UPLOAD_ITEMS', 2)
    def test_returns_error_when_too_many_items(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': '1', 'text': 'a', 'source': 's', 'timestamp': '2026-01-01'},
                {'id': '2', 'text': 'b', 'source': 's', 'timestamp': '2026-01-01'},
                {'id': '3', 'text': 'c', 'source': 's', 'timestamp': '2026-01-01'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'Maximum' in body['error']

    def test_validates_required_fields(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'text': '', 'id': '', 'source': '', 'timestamp': ''},  # all empty
                'not-a-dict',  # not an object
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'Validation failed' in body['error']

    def test_validates_item_not_dict(self, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': ['string-item']}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 400
        assert 'must be an object' in body['error']

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    def test_successful_json_upload(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': 'r1', 'text': 'Great product', 'source': 'app_store', 'timestamp': '2026-01-01T00:00:00Z', 'rating': 5, 'author': 'John'},
                {'id': 'r2', 'text': 'Bad service', 'source_channel': 'web', 'created_at': '2026-01-02T00:00:00Z'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['imported_count'] == 2
        assert body['total_items'] == 2
        assert body['s3_uri'] is not None
        assert mock_sqs.send_message.call_count == 2
        mock_s3.put_object.assert_called_once()

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    def test_json_upload_with_metadata(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': 'r1', 'text': 'Good', 'source': 'api', 'timestamp': '2026-01-01',
                 'metadata': {'custom_field': 'value'}, 'title': 'Title', 'url': 'https://example.com', 'user_id': 'u1'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        # Verify metadata was passed through in SQS message
        sqs_body = json.loads(mock_sqs.send_message.call_args.kwargs['MessageBody'])
        assert sqs_body['metadata'] == {'custom_field': 'value'}
        assert sqs_body['title'] == 'Title'
        assert sqs_body['url'] == 'https://example.com'
        assert sqs_body['author'] == 'u1'

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    def test_json_upload_s3_failure_continues(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        mock_s3.put_object.side_effect = Exception('S3 error')
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': 'r1', 'text': 'Good', 'source': 'api', 'timestamp': '2026-01-01'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['s3_uri'] is None

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', 'https://sqs.example.com/q')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    def test_json_upload_sqs_failure_reports_errors(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        mock_sqs.send_message.side_effect = Exception('SQS error')
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': 'r1', 'text': 'Good', 'source': 'api', 'timestamp': '2026-01-01'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['imported_count'] == 0
        assert 'errors' in body

    @patch('manual_import_handler.PROCESSING_QUEUE_URL', '')
    @patch('manual_import_handler.RAW_DATA_BUCKET', '')
    @patch('manual_import_handler.sqs')
    @patch('manual_import_handler.s3')
    def test_json_upload_no_queue_url(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        """Items counted but not sent when PROCESSING_QUEUE_URL is empty."""
        from manual_import_handler import lambda_handler
        event = api_gateway_event(
            method='POST', path='/scrapers/manual/json-upload',
            body={'items': [
                {'id': 'r1', 'text': 'Good', 'source': 'api', 'timestamp': '2026-01-01'},
            ]}
        )
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['imported_count'] == 1
        mock_sqs.send_message.assert_not_called()
