"""
Tests for data_explorer_handler.py - /data-explorer/* endpoints.
Full CRUD for S3 raw data and DynamoDB feedback.
"""
import json
import os
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

    @patch('data_explorer_handler.get_feedback_table')
    def test_updates_feedback_record(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Updates feedback record in DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_get_table.return_value = mock_table
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

    @patch('data_explorer_handler.get_feedback_table')
    def test_returns_error_when_feedback_id_missing(
        self, mock_get_table, api_gateway_event, lambda_context
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

    @patch('data_explorer_handler.get_feedback_table')
    def test_deletes_feedback_record(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Deletes feedback record from DynamoDB."""
        # Arrange
        mock_table = MagicMock()
        mock_get_table.return_value = mock_table
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

    @patch('data_explorer_handler.get_feedback_table')
    def test_returns_error_when_feedback_not_found(
        self, mock_get_table, api_gateway_event, lambda_context
    ):
        """Returns error when feedback record not found."""
        # Arrange
        mock_table = MagicMock()
        mock_get_table.return_value = mock_table
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


class TestResponseFormatContract:
    """Tests that verify the API response format matches what the frontend expects.
    
    These tests prevent regressions where the backend response structure diverges
    from what the frontend API client expects, causing silent data display failures.
    
    Bug context:
    - S3 browser showed "No files found" because frontend expected {folders, files}
      but backend returned {objects} with isFolder flag
    - Buckets endpoint returned {id, name, label} but frontend expected {name, type}
    """

    @patch('data_explorer_handler.s3_client')
    def test_s3_list_response_has_objects_array(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """S3 list response must contain 'objects' array, not 'folders'/'files'."""
        from datetime import datetime
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [{'Prefix': 'raw/'}],
            'Contents': [
                {'Key': 'test.json', 'Size': 512, 'LastModified': datetime(2025, 3, 1)},
            ]
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Frontend expects 'objects' array (not 'folders' and 'files' separately)
        assert 'objects' in body
        assert isinstance(body['objects'], list)
        # Must NOT have old format keys
        assert 'folders' not in body
        assert 'files' not in body

    @patch('data_explorer_handler.s3_client')
    def test_s3_objects_have_required_fields(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Each S3 object must have key, size, lastModified, isFolder fields."""
        from datetime import datetime
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [{'Prefix': 'raw/'}],
            'Contents': [
                {'Key': 'raw/test.json', 'Size': 512, 'LastModified': datetime(2025, 3, 1)},
            ]
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data', 'prefix': 'raw'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        for obj in body['objects']:
            assert 'key' in obj, f"Object missing 'key': {obj}"
            assert 'size' in obj, f"Object missing 'size': {obj}"
            assert 'isFolder' in obj, f"Object missing 'isFolder': {obj}"
            assert isinstance(obj['isFolder'], bool), f"isFolder must be bool: {obj}"
            
            if not obj['isFolder']:
                assert 'fullKey' in obj, f"File object missing 'fullKey': {obj}"
                assert 'lastModified' in obj, f"File object missing 'lastModified': {obj}"

    @patch('data_explorer_handler.s3_client')
    def test_s3_response_has_bucket_metadata(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """S3 list response must include bucket, bucketId, and prefix."""
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [],
            'Contents': []
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'bucket' in body, "Response must include 'bucket' (actual S3 bucket name)"
        assert 'bucketId' in body, "Response must include 'bucketId' (logical bucket ID)"
        assert 'prefix' in body, "Response must include 'prefix'"
        assert body['bucketId'] == 'raw-data'

    def test_buckets_response_has_id_name_label(
        self, api_gateway_event, lambda_context
    ):
        """Buckets response must include id, name, and label for each bucket."""
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/buckets')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'buckets' in body
        for bucket in body['buckets']:
            assert 'id' in bucket, f"Bucket missing 'id': {bucket}"
            assert 'name' in bucket, f"Bucket missing 'name': {bucket}"
            assert 'label' in bucket, f"Bucket missing 'label': {bucket}"
            # id should be the logical bucket ID (e.g., 'raw-data'), not the S3 name
            assert bucket['id'] != bucket['name'] or bucket['id'] == bucket['name']

    @patch('data_explorer_handler.s3_client')
    def test_s3_folders_sorted_before_files(
        self, mock_s3, api_gateway_event, lambda_context
    ):
        """Objects should be sorted with folders first, then files."""
        from datetime import datetime
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [{'Prefix': 'z-folder/'}],
            'Contents': [
                {'Key': 'a-file.json', 'Size': 100, 'LastModified': datetime(2025, 1, 1)},
            ]
        }
        
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/data-explorer/s3',
            query_params={'bucket': 'raw-data'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Folders should come before files regardless of alphabetical order
        assert body['objects'][0]['isFolder'] is True
        assert body['objects'][0]['key'] == 'z-folder'
        assert body['objects'][1]['isFolder'] is False
        assert body['objects'][1]['key'] == 'a-file.json'


class TestFeedbackResponseContract:
    """Tests for the feedback list endpoint response format used by Data Explorer.
    
    The Data Explorer's Processed Feedback tab calls GET /feedback with Zod validation.
    If the response format doesn't match, Zod throws and the tab shows empty results.
    """

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_feedback_response_has_count_and_items(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Feedback response must have 'count' (number) and 'items' (array)."""
        mock_fb_table.query.return_value = {'Items': []}
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '7', 'limit': '100'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert 'count' in body
        assert 'items' in body
        assert isinstance(body['count'], int)
        assert isinstance(body['items'], list)

    @patch('metrics_handler.feedback_table')
    @patch('metrics_handler.aggregates_table')
    def test_feedback_items_have_required_fields_for_zod(
        self, mock_agg_table, mock_fb_table, api_gateway_event, lambda_context
    ):
        """Each feedback item must have fields required by FeedbackItemSchema."""
        sample_items = [{
            'pk': 'SOURCE#webscraper',
            'sk': 'FEEDBACK#fb-001',
            'gsi1pk': 'DATE#2025-03-20',
            'gsi1sk': '2025-03-20T10:00:00Z#fb-001',
            'feedback_id': 'fb-001',
            'source_id': 'src-001',
            'source_platform': 'webscraper',
            'source_channel': 'web',
            'brand_name': 'TestBrand',
            'source_created_at': '2025-03-20T10:00:00Z',
            'processed_at': '2025-03-20T10:01:00Z',
            'original_text': 'Great product!',
            'original_language': 'en',
            'category': 'product_quality',
            'sentiment_label': 'positive',
            'sentiment_score': Decimal('0.850'),
            'urgency': 'low',
            'impact_area': 'product',
            'date': '2025-03-20',
            'ttl': 1742515260,
        }]
        
        # Only return items for the first day query, empty for the rest
        mock_fb_table.query.side_effect = [
            {'Items': sample_items},
        ] + [{'Items': []}] * 10
        
        from metrics_handler import lambda_handler
        event = api_gateway_event(
            method='GET',
            path='/feedback',
            query_params={'days': '1'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert response['statusCode'] == 200
        assert body['count'] >= 1
        
        item = body['items'][0]
        # These fields are required by FeedbackItemSchema (no default)
        assert 'feedback_id' in item
        assert 'source_platform' in item
        # Decimal should be serialized as a number, not a string
        assert isinstance(item['sentiment_score'], (int, float))
