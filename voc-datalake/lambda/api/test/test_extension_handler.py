"""
Tests for extension_handler.py - /extension/* endpoints.
Chrome extension review ingestion and status.
"""
import json
from unittest.mock import patch, MagicMock, call


class TestSubmitReviews:
    """Tests for POST /extension/reviews endpoint."""

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_submits_parsed_reviews_to_sqs(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Sends each parsed review item to SQS with correct metadata."""
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.return_value = {}

        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com/reviews',
                'page_title': 'Product Reviews',
                'items': [
                    {'text': 'Great product!', 'rating': 5, 'author': 'Alice'},
                    {'text': 'Needs improvement', 'rating': 2, 'author': 'Bob'},
                ]
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        assert body['imported_count'] == 2
        assert body['total_items'] == 2
        assert 'batch_id' in body
        assert mock_sqs.send_message.call_count == 2

        # Verify the SQS message content for the first item
        first_call_body = json.loads(
            mock_sqs.send_message.call_args_list[0].kwargs['MessageBody']
        )
        assert first_call_body['source_platform'] == 'chrome_extension'
        assert first_call_body['source_channel'] == 'review'
        assert first_call_body['text'] == 'Great product!'
        assert first_call_body['rating'] == 5
        assert first_call_body['author'] == 'Alice'
        assert first_call_body['source_url'] == 'https://example.com/reviews'

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_submits_raw_text_as_single_item(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Converts raw_text into a single item and sends to SQS."""
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.return_value = {}

        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com/page',
                'raw_text': 'Selected review text from the page',
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['imported_count'] == 1
        assert body['total_items'] == 1
        mock_sqs.send_message.assert_called_once()

        # Verify the raw text was passed through as the item text
        message_body = json.loads(
            mock_sqs.send_message.call_args.kwargs['MessageBody']
        )
        assert message_body['text'] == 'Selected review text from the page'
        assert message_body['source_platform'] == 'chrome_extension'

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_returns_error_when_source_url_missing(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns validation error mentioning source_url when it's empty."""
        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={'source_url': '', 'raw_text': 'some text'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert 'source_url' in body['error'].lower()

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_returns_error_when_no_text_or_items(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns validation error when neither raw_text nor items provided."""
        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={'source_url': 'https://example.com'}
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert 'raw_text' in body['error'].lower() or 'items' in body['error'].lower()

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_returns_error_when_raw_text_exceeds_max_length(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns validation error referencing the 50KB limit."""
        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com',
                'raw_text': 'x' * 50001,
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert '50000' in body['error'] or 'max' in body['error'].lower()

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_returns_error_when_items_exceed_max_count(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Returns validation error referencing the 100 item limit."""
        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com',
                'items': [{'text': f'Review {i}'} for i in range(101)],
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 400
        assert '100' in body['error']

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_skips_items_with_empty_text(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Only imports items with non-empty text, skips blank ones."""
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.return_value = {}

        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com',
                'items': [
                    {'text': 'Valid review'},
                    {'text': ''},
                    {'text': '   '},
                ]
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['imported_count'] == 1
        assert body['total_items'] == 3
        mock_sqs.send_message.assert_called_once()

    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_reports_sqs_errors_per_item(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Reports errors for individual SQS send failures while continuing."""
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.side_effect = [
            {},
            Exception('SQS throttled'),
        ]

        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com',
                'items': [
                    {'text': 'Review 1'},
                    {'text': 'Review 2'},
                ]
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # First item succeeded, second failed
        assert body['success'] is True
        assert body['imported_count'] == 1
        assert len(body['errors']) == 1
        assert 'Item 1' in body['errors'][0]

    @patch('extension_handler.RAW_DATA_BUCKET', '')
    @patch('extension_handler.sqs')
    @patch('extension_handler.s3')
    def test_handles_missing_s3_bucket_gracefully(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Proceeds without S3 storage when bucket not configured."""
        mock_sqs.send_message.return_value = {}

        from extension_handler import lambda_handler

        event = api_gateway_event(
            method='POST',
            path='/extension/reviews',
            body={
                'source_url': 'https://example.com',
                'items': [{'text': 'Review'}],
            }
        )

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert body['success'] is True
        assert body['s3_uri'] is None
        assert body['imported_count'] == 1
        # S3 should not have been called
        mock_s3.put_object.assert_not_called()


class TestGetStatus:
    """Tests for GET /extension/status endpoint."""

    def test_returns_status_with_user_info(
        self, api_gateway_event, lambda_context
    ):
        """Returns user ID from Cognito claims and queue configuration status."""
        from extension_handler import lambda_handler

        event = api_gateway_event(method='GET', path='/extension/status')

        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        assert response['statusCode'] == 200
        assert body['success'] is True
        # conftest sets sub='test-user-id' in Cognito claims
        assert body['user_id'] == 'test-user-id'
        # conftest sets PROCESSING_QUEUE_URL to a non-empty value
        assert body['configured'] is True
