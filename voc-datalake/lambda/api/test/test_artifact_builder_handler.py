"""
Tests for artifact_builder_handler.py - Artifact generation job management.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestDecimalDefault:
    """Tests for decimal_default JSON serializer."""

    def test_converts_decimal_to_int(self):
        """Converts Decimal with no fractional part to int."""
        from decimal import Decimal
        import sys
        import os
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from artifact_builder_handler import decimal_default
        
        assert decimal_default(Decimal('100')) == 100
        assert decimal_default(Decimal('0')) == 0

    def test_converts_decimal_to_float(self):
        """Converts Decimal with fractional part to float."""
        from decimal import Decimal
        from artifact_builder_handler import decimal_default
        
        assert decimal_default(Decimal('3.14')) == 3.14
        assert decimal_default(Decimal('0.5')) == 0.5

    def test_raises_type_error_for_non_decimal(self):
        """Raises TypeError for non-Decimal types."""
        from artifact_builder_handler import decimal_default
        
        with pytest.raises(TypeError):
            decimal_default({'key': 'value'})


class TestStripAnsiCodes:
    """Tests for strip_ansi_codes helper function."""

    def test_strips_basic_ansi_codes(self):
        """Strips basic ANSI escape codes."""
        from artifact_builder_handler import strip_ansi_codes
        
        text = "\x1B[32mGreen text\x1B[0m"
        result = strip_ansi_codes(text)
        assert "Green text" in result
        assert "\x1B" not in result

    def test_strips_cursor_control_codes(self):
        """Strips cursor control codes."""
        from artifact_builder_handler import strip_ansi_codes
        
        text = "\x1B[?25lHidden cursor\x1B[?25h"
        result = strip_ansi_codes(text)
        assert "Hidden cursor" in result

    def test_normalizes_line_endings(self):
        """Normalizes different line endings."""
        from artifact_builder_handler import strip_ansi_codes
        
        text = "Line1\r\nLine2\rLine3"
        result = strip_ansi_codes(text)
        assert "\r" not in result

    def test_handles_empty_string(self):
        """Handles empty string input."""
        from artifact_builder_handler import strip_ansi_codes
        
        assert strip_ansi_codes("") == ""

    def test_handles_plain_text(self):
        """Handles plain text without ANSI codes."""
        from artifact_builder_handler import strip_ansi_codes
        
        text = "Plain text without codes"
        result = strip_ansi_codes(text)
        assert result == text


class TestListTemplatesEndpoint:
    """Tests for GET /templates endpoint."""

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_templates_and_styles(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns available templates and style presets."""
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/templates')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'templates' in body
        assert 'styles' in body
        assert len(body['templates']) > 0
        assert len(body['styles']) > 0


class TestCreateJobEndpoint:
    """Tests for POST /jobs endpoint."""

    @patch('artifact_builder_handler.sqs')
    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_creates_job_successfully(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Creates a new artifact generation job."""
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/jobs',
            body={
                'prompt': 'Create a landing page for a SaaS product',
                'project_type': 'react-vite',
                'style': 'minimal'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'job_id' in body
        assert body['status'] == 'queued'
        mock_table.put_item.assert_called_once()
        mock_s3.put_object.assert_called_once()

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_error_when_prompt_missing(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when prompt is not provided."""
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/jobs',
            body={'project_type': 'react-vite'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 400

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_error_when_prompt_too_long(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when prompt exceeds maximum length."""
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/jobs',
            body={'prompt': 'x' * 50001}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 400

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_error_for_invalid_project_type(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error for invalid project type."""
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/jobs',
            body={'prompt': 'Test prompt', 'project_type': 'invalid-type'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 400

    @patch('artifact_builder_handler.sqs')
    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_creates_iteration_job_from_parent(
        self, mock_table, mock_s3, mock_sqs, api_gateway_event, lambda_context
    ):
        """Creates iteration job referencing parent job."""
        mock_table.get_item.return_value = {
            'Item': {'status': 'done', 'job_id': 'parent-123'}
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='POST',
            path='/jobs',
            body={
                'prompt': 'Add a contact form',
                'parent_job_id': 'parent-123'
            }
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['parent_job_id'] == 'parent-123'


class TestListJobsEndpoint:
    """Tests for GET /jobs endpoint."""

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_list_of_jobs(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns list of all jobs."""
        mock_table.scan.return_value = {
            'Items': [
                {'job_id': 'job-1', 'status': 'done', 'created_at': '2026-01-07T10:00:00Z'},
                {'job_id': 'job-2', 'status': 'queued', 'created_at': '2026-01-07T11:00:00Z'}
            ]
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(method='GET', path='/jobs')
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'jobs' in body
        assert body['count'] == 2

    @patch('artifact_builder_handler.jobs_table')
    def test_filters_by_status(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Filters jobs by status when parameter provided."""
        mock_table.query.return_value = {
            'Items': [{'job_id': 'job-1', 'status': 'done'}]
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs',
            query_params={'status': 'done'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        mock_table.query.assert_called_once()
        assert body['count'] == 1


class TestGetJobEndpoint:
    """Tests for GET /jobs/<job_id> endpoint."""

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_job_details(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns job details for existing job."""
        mock_table.get_item.return_value = {
            'Item': {
                'job_id': 'job-123',
                'status': 'done',
                'prompt': 'Test prompt',
                'created_at': '2026-01-07T10:00:00Z'
            }
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['job_id'] == 'job-123'
        assert body['status'] == 'done'

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_not_found_for_missing_job(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 404 when job doesn't exist."""
        mock_table.get_item.return_value = {}
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/nonexistent',
            path_params={'job_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 404


class TestGetJobLogsEndpoint:
    """Tests for GET /jobs/<job_id>/logs endpoint."""

    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_returns_job_logs(
        self, mock_table, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns logs for existing job."""
        mock_table.get_item.return_value = {'Item': {'job_id': 'job-123'}}
        mock_s3.get_object.return_value = {
            'Body': MagicMock(read=lambda: b'Build started...\nBuild completed.')
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/job-123/logs',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['job_id'] == 'job-123'
        assert 'logs' in body

    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_returns_placeholder_when_logs_not_available(
        self, mock_table, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns placeholder when logs not yet available."""
        mock_table.get_item.return_value = {'Item': {'job_id': 'job-123'}}
        # Mock the NoSuchKey exception properly
        mock_s3.exceptions = MagicMock()
        mock_s3.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})
        mock_s3.get_object.side_effect = Exception('NoSuchKey')
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/job-123/logs',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'not yet available' in body['logs']


class TestGetDownloadUrlEndpoint:
    """Tests for GET /jobs/<job_id>/download endpoint."""

    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_returns_presigned_url(
        self, mock_table, mock_s3, api_gateway_event, lambda_context
    ):
        """Returns presigned download URL for completed job."""
        mock_table.get_item.return_value = {
            'Item': {'job_id': 'job-123', 'status': 'done'}
        }
        mock_s3.generate_presigned_url.return_value = 'https://s3.example.com/presigned'
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/job-123/download',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert 'download_url' in body
        assert body['expires_in'] == 3600

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_error_when_job_not_complete(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns error when job is not complete."""
        mock_table.get_item.return_value = {
            'Item': {'job_id': 'job-123', 'status': 'generating'}
        }
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='GET',
            path='/jobs/job-123/download',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 400


class TestDeleteJobEndpoint:
    """Tests for DELETE /jobs/<job_id> endpoint."""

    @patch('artifact_builder_handler.ecs')
    @patch('artifact_builder_handler.codecommit')
    @patch('artifact_builder_handler.s3')
    @patch('artifact_builder_handler.jobs_table')
    def test_deletes_job_and_artifacts(
        self, mock_table, mock_s3, mock_codecommit, mock_ecs, api_gateway_event, lambda_context
    ):
        """Deletes job and all associated artifacts."""
        mock_table.get_item.return_value = {
            'Item': {'job_id': 'job-123', 'status': 'done'}
        }
        mock_s3.get_paginator.return_value.paginate.return_value = [
            {'Contents': [{'Key': 'jobs/job-123/file1.txt'}]}
        ]
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/jobs/job-123',
            path_params={'job_id': 'job-123'}
        )
        
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])
        
        assert body['success'] is True
        mock_table.delete_item.assert_called_once()

    @patch('artifact_builder_handler.jobs_table')
    def test_returns_not_found_for_missing_job(
        self, mock_table, api_gateway_event, lambda_context
    ):
        """Returns 404 when job doesn't exist."""
        mock_table.get_item.return_value = {}
        
        from artifact_builder_handler import lambda_handler
        
        event = api_gateway_event(
            method='DELETE',
            path='/jobs/nonexistent',
            path_params={'job_id': 'nonexistent'}
        )
        
        response = lambda_handler(event, lambda_context)
        
        assert response['statusCode'] == 404
