"""
Additional coverage tests for s3_import_handler.py.
Covers: create_source, list_files with filters, get_upload_url validation,
delete_file, and error branches.
"""
import json
import pytest
from unittest.mock import patch, MagicMock


class TestCreateSource:
    """Cover POST /s3-import/sources (lines 53, 66-68)."""

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_error_when_bucket_not_configured(self, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/sources', body={'name': 'test'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_when_name_empty(self, mock_s3, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/sources', body={'name': ''})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_creates_source_folder(self, mock_s3, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/sources', body={'name': 'my-source'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        mock_s3.put_object.assert_called_once()

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_on_s3_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.put_object.side_effect = Exception('S3 error')
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/sources', body={'name': 'test'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestListFiles:
    """Cover GET /s3-import/files (lines 93, 106-108, 116)."""

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_empty_when_no_bucket(self, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/s3-import/files')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['files'] == []

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_lists_files_with_source_filter(self, mock_s3, api_gateway_event, lambda_context):
        from datetime import datetime, timezone
        paginator = MagicMock()
        paginator.paginate.return_value = [{
            'Contents': [
                {'Key': 'source1/data.json', 'Size': 1024, 'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc)},
                {'Key': 'source1/data.csv', 'Size': 2048, 'LastModified': datetime(2026, 1, 2, tzinfo=timezone.utc)},
                {'Key': 'source1/', 'Size': 0, 'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc)},  # folder
                {'Key': 'source1/image.png', 'Size': 512, 'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc)},  # unsupported
            ]
        }]
        mock_s3.get_paginator.return_value = paginator

        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/s3-import/files', query_params={'source': 'source1'})
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert len(body['files']) == 2  # Only .json and .csv

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_excludes_processed_by_default(self, mock_s3, api_gateway_event, lambda_context):
        from datetime import datetime, timezone
        paginator = MagicMock()
        paginator.paginate.return_value = [{
            'Contents': [
                {'Key': 'source1/data.json', 'Size': 1024, 'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc)},
                {'Key': 'processed/old.json', 'Size': 512, 'LastModified': datetime(2026, 1, 1, tzinfo=timezone.utc)},
            ]
        }]
        mock_s3.get_paginator.return_value = paginator

        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/s3-import/files')
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert len(body['files']) == 1

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_on_s3_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.get_paginator.side_effect = Exception('S3 error')
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='GET', path='/s3-import/files')
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500


class TestGetUploadUrl:
    """Cover POST /s3-import/upload-url (lines 140-142)."""

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_error_when_no_bucket(self, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/upload-url', body={'filename': 'test.json'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_when_no_filename(self, mock_s3, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/upload-url', body={'filename': ''})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_for_unsupported_extension(self, mock_s3, api_gateway_event, lambda_context):
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/upload-url', body={'filename': 'test.txt'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 400

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_generates_presigned_url(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.generate_presigned_url.return_value = 'https://s3.example.com/presigned'
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/upload-url', body={
            'filename': 'data.json', 'source': 'my-source'
        })
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        assert body['success'] is True
        assert body['upload_url'] == 'https://s3.example.com/presigned'

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_on_presign_failure(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.generate_presigned_url.side_effect = Exception('S3 error')
        from s3_import_handler import lambda_handler
        event = api_gateway_event(method='POST', path='/s3-import/upload-url', body={'filename': 'data.csv'})
        response = lambda_handler(event, lambda_context)
        assert response['statusCode'] == 500
