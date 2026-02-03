"""
Tests for s3_import_handler.py - S3 import bucket file explorer.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestListSourcesEndpoint:
    """Tests for GET /s3-import/sources endpoint."""

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_source_folders(self, mock_s3, api_gateway_event, lambda_context):
        """Returns list of source folders from S3."""
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [
                {'Prefix': 'webscraper/'},
                {'Prefix': 'g2/'},
                {'Prefix': 'processed/'}  # Should be excluded
            ]
        }
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/s3-import/sources')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'sources' in body
        assert len(body['sources']) == 2  # processed excluded
        assert body['bucket'] == 'test-bucket'

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_empty_when_bucket_not_configured(self, api_gateway_event, lambda_context):
        """Returns empty list when bucket not configured."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/s3-import/sources')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['sources'] == []
        assert body['bucket'] is None

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_handles_s3_error(self, mock_s3, api_gateway_event, lambda_context):
        """Handles S3 error gracefully."""
        mock_s3.list_objects_v2.side_effect = Exception('S3 error')
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/s3-import/sources')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body


class TestCreateSourceEndpoint:
    """Tests for POST /s3-import/sources endpoint."""

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_creates_source_folder(self, mock_s3, api_gateway_event, lambda_context):
        """Creates new source folder in S3."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/sources',
            body={'name': 'new-source'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert body['source']['name'] == 'new-source'
        mock_s3.put_object.assert_called_once()

    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_when_name_missing(self, api_gateway_event, lambda_context):
        """Returns error when source name not provided."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/sources',
            body={'name': ''}  # Empty name
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_sanitizes_source_name(self, mock_s3, api_gateway_event, lambda_context):
        """Sanitizes source name to safe characters."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/sources',
            body={'name': 'my source!@#$%'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        # Name should be sanitized
        assert '!' not in body['source']['name']
        assert '@' not in body['source']['name']


class TestListFilesEndpoint:
    """Tests for GET /s3-import/files endpoint."""

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_files_list(self, mock_s3, api_gateway_event, lambda_context):
        """Returns list of files from S3."""
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'Contents': [
                    {'Key': 'webscraper/data.json', 'Size': 1024, 'LastModified': datetime.now(timezone.utc)},
                    {'Key': 'webscraper/reviews.csv', 'Size': 2048, 'LastModified': datetime.now(timezone.utc)}
                ]
            }
        ]
        mock_s3.get_paginator.return_value = paginator
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/s3-import/files',
            query_params={'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'files' in body
        assert len(body['files']) == 2

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_filters_by_file_extension(self, mock_s3, api_gateway_event, lambda_context):
        """Only returns CSV, JSON, and JSONL files."""
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                'Contents': [
                    {'Key': 'data.json', 'Size': 1024, 'LastModified': datetime.now(timezone.utc)},
                    {'Key': 'data.txt', 'Size': 512, 'LastModified': datetime.now(timezone.utc)},  # Should be excluded
                    {'Key': 'data.csv', 'Size': 2048, 'LastModified': datetime.now(timezone.utc)}
                ]
            }
        ]
        mock_s3.get_paginator.return_value = paginator
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/s3-import/files')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert len(body['files']) == 2  # txt excluded

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_empty_when_bucket_not_configured(self, api_gateway_event, lambda_context):
        """Returns empty list when bucket not configured."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/s3-import/files')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['files'] == []


class TestGetUploadUrlEndpoint:
    """Tests for POST /s3-import/upload-url endpoint."""

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_presigned_url(self, mock_s3, api_gateway_event, lambda_context):
        """Returns presigned upload URL."""
        mock_s3.generate_presigned_url.return_value = 'https://s3.example.com/presigned'
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/upload-url',
            body={'filename': 'data.json', 'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        assert 'upload_url' in body
        assert body['expires_in'] == 3600

    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_returns_error_when_filename_missing(self, api_gateway_event, lambda_context):
        """Returns error when filename not provided."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/upload-url',
            body={'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'required' in body['error'].lower()

    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_rejects_unsupported_file_types(self, api_gateway_event, lambda_context):
        """Rejects unsupported file types."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/s3-import/upload-url',
            body={'filename': 'data.txt', 'source': 'webscraper'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 400 with error key
        assert response['statusCode'] == 400
        assert 'error' in body
        assert 'supported' in body['error'].lower()


class TestDeleteFileEndpoint:
    """Tests for DELETE /s3-import/file/<key> endpoint."""

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_deletes_file(self, mock_s3, api_gateway_event, lambda_context):
        """Deletes file from S3."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/s3-import/file/webscraper%2Fdata.json',
            path_params={'key': 'webscraper%2Fdata.json'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_s3.delete_object.assert_called_once()

    @patch('s3_import_handler.s3_client')
    @patch('s3_import_handler.S3_IMPORT_BUCKET', 'test-bucket')
    def test_handles_delete_error(self, mock_s3, api_gateway_event, lambda_context):
        """Handles S3 delete error."""
        mock_s3.delete_object.side_effect = Exception('Delete failed')
        
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/s3-import/file/webscraper%2Fdata.json',
            path_params={'key': 'webscraper%2Fdata.json'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body

    @patch('s3_import_handler.S3_IMPORT_BUCKET', '')
    def test_returns_error_when_bucket_not_configured(self, api_gateway_event, lambda_context):
        """Returns error when bucket not configured."""
        from s3_import_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/s3-import/file/data.json',
            path_params={'key': 'data.json'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        # Now returns 500 with error key
        assert response['statusCode'] == 500
        assert 'error' in body
