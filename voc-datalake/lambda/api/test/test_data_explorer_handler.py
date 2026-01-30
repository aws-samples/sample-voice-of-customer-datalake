"""
Tests for data_explorer_handler.py - /data-explorer/* endpoints.
Full CRUD for S3 raw data and DynamoDB feedback.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestListS3Objects:
    """Tests for GET /data-explorer/s3 endpoint."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_files_and_folders(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns list of files and folders from S3."""
        # Arrange
        from datetime import datetime
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [
                {'Prefix': 'webscraper/'},
                {'Prefix': 'manual_import/'}
            ],
            'Contents': [
                {'Key': 'readme.txt', 'Size': 100, 'LastModified': datetime(2025, 1, 1)},
            ]
        }
        
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from data_explorer_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert len(body['objects']) == 3  # 2 folders + 1 file
        
        folders = [o for o in body['objects'] if o['isFolder']]
        files = [o for o in body['objects'] if not o['isFolder']]
        assert len(folders) == 2
        assert len(files) == 1

    @patch('data_explorer_handler.s3_client')
    def test_navigates_into_prefix(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Navigates into folder prefix."""
        # Arrange
        from datetime import datetime
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [],
            'Contents': [
                {'Key': 'webscraper/review-1.json', 'Size': 500, 'LastModified': datetime(2025, 1, 1)},
            ]
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data', 'prefix': 'webscraper'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['prefix'] == 'webscraper'
        mock_s3.list_objects_v2.assert_called_once()
        call_args = mock_s3.list_objects_v2.call_args
        assert call_args[1]['Prefix'] == 'webscraper/'


class TestPreviewS3File:
    """Tests for GET /data-explorer/s3/preview endpoint."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_json_file_content(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns parsed JSON content for JSON files."""
        # Arrange
        json_content = {'feedback_id': '123', 'text': 'Great product!'}
        mock_s3.head_object.return_value = {
            'ContentLength': 100,
            'ContentType': 'application/json'
        }
        mock_body = MagicMock()
        mock_body.read.return_value = json.dumps(json_content).encode()
        mock_s3.get_object.return_value = {'Body': mock_body}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3/preview',
            query_params={'bucket': 'raw-data', 'key': 'webscraper/review-1.json'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['content']['feedback_id'] == '123'

    @patch('data_explorer_handler.s3_client')
    def test_returns_presigned_url_for_images(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns presigned URL for image files."""
        # Arrange
        mock_s3.head_object.return_value = {
            'ContentLength': 50000,
            'ContentType': 'image/png'
        }
        mock_s3.generate_presigned_url.return_value = 'https://s3.amazonaws.com/presigned-url'
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3/preview',
            query_params={'bucket': 'raw-data', 'key': 'images/screenshot.png'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['isPresignedUrl'] is True
        assert 'presigned-url' in body['content']

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_for_missing_file(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns error when file not found."""
        # Arrange
        class NoSuchKey(Exception):
            pass
        mock_s3.exceptions = MagicMock()
        mock_s3.exceptions.NoSuchKey = NoSuchKey
        mock_s3.head_object.side_effect = NoSuchKey()
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3/preview',
            query_params={'bucket': 'raw-data', 'key': 'nonexistent.json'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body


class TestSaveS3File:
    """Tests for PUT /data-explorer/s3 endpoint."""

    @patch('data_explorer_handler.s3_client')
    def test_saves_file_to_s3(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Saves file content to S3."""
        # Arrange
        mock_s3.put_object.return_value = {}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/s3',
            body={
                'bucket': 'raw-data',
                'key': 'webscraper/new-review.json',
                'content': {'feedback_id': 'new-123', 'text': 'New feedback'}
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_s3.put_object.assert_called_once()

    @patch('data_explorer_handler.sqs_client')
    @patch('data_explorer_handler.s3_client')
    def test_syncs_to_dynamodb_when_requested(
        self, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Sends to processing queue when sync_to_dynamo is True."""
        # Arrange
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.return_value = {}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/s3',
            body={
                'bucket': 'raw-data',
                'key': 'webscraper/review.json',
                'content': {'feedback_id': '123'},
                'sync_to_dynamo': True
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert body['success'] is True
        assert body['synced'] is True


class TestDeleteS3File:
    """Tests for DELETE /data-explorer/s3 endpoint."""

    @patch('data_explorer_handler.s3_client')
    def test_deletes_file_from_s3(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Deletes file from S3."""
        # Arrange
        mock_s3.delete_object.return_value = {}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data', 'key': 'webscraper/old-review.json'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True
        mock_s3.delete_object.assert_called_once()


class TestSaveFeedback:
    """Tests for PUT /data-explorer/feedback endpoint."""

    @patch('data_explorer_handler.dynamodb')
    def test_updates_feedback_record(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Updates feedback record in DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.update_item.return_value = {}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/feedback',
            body={
                'feedback_id': 'fb-123',
                'data': {
                    'source_platform': 'webscraper',
                    'original_text': 'Updated text',
                    'sentiment_label': 'positive',
                    'sentiment_score': 0.85
                }
            }
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True

    @patch('data_explorer_handler.dynamodb')
    def test_returns_error_when_feedback_id_missing(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Returns error when feedback_id not provided."""
        # Arrange
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/feedback',
            body={'data': {'text': 'test'}}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()


class TestDeleteFeedback:
    """Tests for DELETE /data-explorer/feedback endpoint."""

    @patch('data_explorer_handler.dynamodb')
    def test_deletes_feedback_record(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Deletes feedback record from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {
            'Items': [{'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#fb-123'}]
        }
        mock_table.delete_item.return_value = {}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/data-explorer/feedback',
            query_params={'feedback_id': 'fb-123'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert body['success'] is True

    @patch('data_explorer_handler.dynamodb')
    def test_returns_error_when_feedback_not_found(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Returns error when feedback record not found."""
        # Arrange
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': []}
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='DELETE',
            path='/data-explorer/feedback',
            query_params={'feedback_id': 'nonexistent'}
        )
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert - now returns 404 with error key
        assert response['statusCode'] == 404
        assert 'error' in body
        assert 'not found' in body['error'].lower()


class TestListBuckets:
    """Tests for GET /data-explorer/buckets endpoint."""

    def test_returns_available_buckets(
        self, api_gateway_event, lambda_context
    ):
        """Returns list of available S3 buckets."""
        # Arrange
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/buckets')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 'buckets' in body


class TestGetDataStats:
    """Tests for GET /data-explorer/stats endpoint."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_data_lake_statistics(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns statistics about the data lake."""
        # Arrange
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [
                {'Prefix': 'webscraper/'},
                {'Prefix': 'manual_import/'}
            ]
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/stats')
        
        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Assert
        assert response['statusCode'] == 200
        assert 's3' in body
        assert 'dynamodb' in body


class TestDecimalToNative:
    """Tests for decimal_to_native helper function."""

    def test_converts_decimal_to_int(self):
        """Converts whole number Decimal to int."""
        from data_explorer_handler import decimal_to_native
        
        result = decimal_to_native(Decimal('42'))
        assert result == 42
        assert isinstance(result, int)

    def test_converts_decimal_to_float(self):
        """Converts fractional Decimal to float."""
        from data_explorer_handler import decimal_to_native
        
        result = decimal_to_native(Decimal('3.14'))
        assert result == 3.14
        assert isinstance(result, float)

    def test_converts_nested_dict(self):
        """Converts Decimals in nested dict."""
        from data_explorer_handler import decimal_to_native
        
        data = {
            'count': Decimal('100'),
            'score': Decimal('0.85'),
            'nested': {'value': Decimal('42')}
        }
        
        result = decimal_to_native(data)
        assert result['count'] == 100
        assert result['score'] == 0.85
        assert result['nested']['value'] == 42

    def test_converts_list_items(self):
        """Converts Decimals in list."""
        from data_explorer_handler import decimal_to_native
        
        data = [Decimal('1'), Decimal('2.5'), Decimal('3')]
        
        result = decimal_to_native(data)
        assert result == [1, 2.5, 3]
