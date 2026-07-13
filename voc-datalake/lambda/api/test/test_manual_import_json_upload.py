"""
Coverage tests for the POST /scrapers/manual/json-upload endpoint
in manual_import_handler.py.
"""
import json
from unittest.mock import patch


class TestJsonUploadEndpoint:
    """Cover POST /scrapers/manual/json-upload endpoint."""

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
                {'id': 'r1', 'text': 'Great product', 'source': 'app_store',
                 'timestamp': '2026-01-01T00:00:00Z', 'rating': 5, 'author': 'John'},
                {'id': 'r2', 'text': 'Bad service', 'source_channel': 'web',
                 'created_at': '2026-01-02T00:00:00Z'},
            ]}
        )
        mock_sqs.send_message_batch.side_effect = lambda QueueUrl, Entries: {
            'Successful': [{'Id': e['Id']} for e in Entries], 'Failed': [],
        }
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['imported_count'] == 2
        assert body['total_items'] == 2
        assert body['s3_uri'] is not None
        # Items are sent via SendMessageBatch (both fit one batch of <=10),
        # not one send_message per item — the P9 batching regression check.
        assert mock_sqs.send_message_batch.call_count == 1
        assert len(mock_sqs.send_message_batch.call_args.kwargs['Entries']) == 2
        mock_sqs.send_message.assert_not_called()
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
                 'metadata': {'custom_field': 'value'}, 'title': 'Title',
                 'url': 'https://example.com', 'user_id': 'u1'},
            ]}
        )
        mock_sqs.send_message_batch.side_effect = lambda QueueUrl, Entries: {
            'Successful': [{'Id': e['Id']} for e in Entries], 'Failed': [],
        }
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        # Verify metadata was passed through in the batched SQS message
        entries = mock_sqs.send_message_batch.call_args.kwargs['Entries']
        sqs_body = json.loads(entries[0]['MessageBody'])
        assert sqs_body['metadata'] == {'custom_field': 'value'}
