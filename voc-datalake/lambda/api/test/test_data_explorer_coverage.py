"""
Additional coverage tests for data_explorer_handler.py.
Covers: no-bucket paths, preview edge cases (large files, text files, no-key),
save errors, delete errors, feedback CRUD edge cases, stats error paths.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal


class TestListS3ObjectsEdgeCases:
    """Cover list_s3_objects error and no-bucket paths."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_bucket_not_configured(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3', query_params={'bucket': 'nonexistent'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['objects'] == []
        assert 'error' in body

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_on_s3_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.list_objects_v2.side_effect = Exception('S3 error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3', query_params={'bucket': 'raw-data'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.s3_client')
    def test_skips_prefix_itself_in_contents(self, mock_s3, api_gateway_event, lambda_context):
        """Cover the `if key == prefix: continue` branch."""
        from datetime import datetime as dt
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [],
            'Contents': [
                {'Key': 'raw/', 'Size': 0, 'LastModified': dt(2025, 1, 1)},
                {'Key': 'raw/file.json', 'Size': 100, 'LastModified': dt(2025, 1, 1)},
            ]
        }
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3', query_params={'bucket': 'raw-data', 'prefix': 'raw'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert len(body['objects']) == 1


class TestPreviewS3FileEdgeCases:
    """Cover preview edge cases."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_bucket(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'nonexistent', 'key': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_key(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'raw-data'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('data_explorer_handler.s3_client')
    def test_truncates_large_text_files(self, mock_s3, api_gateway_event, lambda_context):
        """Cover the large file truncation branch."""
        mock_s3.head_object.return_value = {'ContentLength': 2 * 1024 * 1024, 'ContentType': 'text/plain'}
        mock_body = MagicMock()
        mock_body.read.return_value = b'x' * (1024 * 1024)
        mock_s3.get_object.return_value = {'Body': mock_body}
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'raw-data', 'key': 'big.txt'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert 'truncated' in body['content']

    @patch('data_explorer_handler.s3_client')
    def test_returns_raw_text_for_non_json(self, mock_s3, api_gateway_event, lambda_context):
        """Cover the JSONDecodeError branch."""
        mock_s3.head_object.return_value = {'ContentLength': 50, 'ContentType': 'text/plain'}
        mock_body = MagicMock()
        mock_body.read.return_value = b'This is not JSON'
        mock_s3.get_object.return_value = {'Body': mock_body}
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'raw-data', 'key': 'readme.txt'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        assert body['content'] == 'This is not JSON'

    @patch('data_explorer_handler.s3_client')
    def test_returns_presigned_url_for_pdf(self, mock_s3, api_gateway_event, lambda_context):
        """Cover the PDF detection branch."""
        mock_s3.head_object.return_value = {'ContentLength': 5000, 'ContentType': 'application/pdf'}
        mock_s3.generate_presigned_url.return_value = 'https://presigned'
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'raw-data', 'key': 'doc.pdf'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['isPresignedUrl'] is True

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_on_generic_exception(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.exceptions = MagicMock()
        mock_s3.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})
        mock_s3.head_object.side_effect = Exception('Unexpected')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/s3/preview', query_params={'bucket': 'raw-data', 'key': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestSaveS3FileEdgeCases:
    """Cover save_s3_file error paths."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_bucket(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/s3', body={'bucket': 'nonexistent', 'key': 'x', 'content': '{}'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_key(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/s3', body={'bucket': 'raw-data', 'key': '', 'content': '{}'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_on_s3_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.put_object.side_effect = Exception('S3 error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/s3', body={'bucket': 'raw-data', 'key': 'x.json', 'content': 'data'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.sqs_client')
    @patch('data_explorer_handler.s3_client')
    def test_handles_sync_failure_gracefully(self, mock_s3, mock_sqs, api_gateway_event, lambda_context):
        """Cover the sync_to_dynamo failure branch."""
        mock_s3.put_object.return_value = {}
        mock_sqs.send_message.side_effect = Exception('SQS error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/s3', body={
            'bucket': 'raw-data', 'key': 'x.json', 'content': '{"id": "1"}', 'sync_to_dynamo': True
        })
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['synced'] is False


class TestDeleteS3FileEdgeCases:
    """Cover delete_s3_file error paths."""

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_bucket(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/s3', query_params={'bucket': 'nonexistent', 'key': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_when_no_key(self, mock_s3, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/s3', query_params={'bucket': 'raw-data'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('data_explorer_handler.s3_client')
    def test_returns_error_on_s3_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.delete_object.side_effect = Exception('S3 error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/s3', query_params={'bucket': 'raw-data', 'key': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestSaveFeedbackEdgeCases:
    """Cover save_feedback edge cases."""

    @patch('data_explorer_handler.FEEDBACK_TABLE', '')
    def test_returns_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={'feedback_id': 'x', 'data': {}})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.dynamodb')
    def test_returns_error_when_no_fields_to_update(self, mock_dynamodb, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={
            'feedback_id': 'x', 'data': {'source_platform': 'webscraper'}
        })
        response = lambda_handler(event, lambda_context)
        # ValidationError is caught by generic except and re-raised as ServiceError (500)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.dynamodb')
    def test_queries_gsi_when_no_source_platform(self, mock_dynamodb, api_gateway_event, lambda_context):
        """Cover the branch where source_platform is empty and GSI is queried."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': [{'pk': 'SOURCE#ws', 'sk': 'FEEDBACK#x'}]}
        mock_table.update_item.return_value = {}
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={
            'feedback_id': 'x', 'data': {'original_text': 'Updated'}
        })
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True

    @patch('data_explorer_handler.dynamodb')
    def test_returns_not_found_when_gsi_returns_empty(self, mock_dynamodb, api_gateway_event, lambda_context):
        """Cover the NotFoundError branch when GSI returns no items."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': []}
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={
            'feedback_id': 'x', 'data': {'original_text': 'Updated'}
        })
        response = lambda_handler(event, lambda_context)
        # NotFoundError is caught by generic except and re-raised as ServiceError (500)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('data_explorer_handler.s3_client')
    @patch('data_explorer_handler.dynamodb')
    def test_syncs_to_s3_when_requested(self, mock_dynamodb, mock_s3, api_gateway_event, lambda_context):
        """Cover the sync_to_s3 branch."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.update_item.return_value = {}
        mock_s3.put_object.return_value = {}
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={
            'feedback_id': 'x',
            'data': {
                'source_platform': 'webscraper',
                'original_text': 'Updated',
                's3_raw_uri': 's3://test-bucket/raw/webscraper/2025/01/01/x.json',
            },
            'sync_to_s3': True,
        })
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['synced'] is True

    @patch('data_explorer_handler.RAW_DATA_BUCKET', 'test-bucket')
    @patch('data_explorer_handler.s3_client')
    @patch('data_explorer_handler.dynamodb')
    def test_handles_s3_sync_failure(self, mock_dynamodb, mock_s3, api_gateway_event, lambda_context):
        """Cover the S3 sync failure branch."""
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.update_item.return_value = {}
        mock_s3.put_object.side_effect = Exception('S3 error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='PUT', path='/data-explorer/feedback', body={
            'feedback_id': 'x',
            'data': {
                'source_platform': 'webscraper',
                'original_text': 'Updated',
                's3_raw_uri': 's3://test-bucket/raw/webscraper/2025/01/01/x.json',
            },
            'sync_to_s3': True,
        })
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['synced'] is False


class TestDeleteFeedbackEdgeCases:
    """Cover delete_feedback error paths."""

    @patch('data_explorer_handler.FEEDBACK_TABLE', '')
    def test_returns_error_when_table_not_configured(self, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/feedback', query_params={'feedback_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('data_explorer_handler.dynamodb')
    def test_returns_error_when_no_feedback_id(self, mock_dynamodb, api_gateway_event, lambda_context):
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/feedback', query_params={})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('data_explorer_handler.dynamodb')
    def test_returns_error_on_delete_failure(self, mock_dynamodb, api_gateway_event, lambda_context):
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': [{'pk': 'SOURCE#ws', 'sk': 'FEEDBACK#x'}]}
        mock_table.delete_item.side_effect = Exception('DynamoDB error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='DELETE', path='/data-explorer/feedback', query_params={'feedback_id': 'x'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetDataStatsEdgeCases:
    """Cover stats error path."""

    @patch('data_explorer_handler.s3_client')
    def test_handles_s3_stats_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.list_objects_v2.side_effect = Exception('S3 error')
        from data_explorer_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/data-explorer/stats')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert response['statusCode'] == 200
        # Should still return stats with error in bucket info
        assert 's3' in body
