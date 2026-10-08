"""Regression tests for issue #263 on data_explorer_handler.py (ported from PR #403).

Two contracts:
- a typed 4xx (`ApiError` subclass) raised inside a route's broad `try` keeps
  its own status instead of being rewrapped as a 500 by `except Exception`;
- a client-facing body never carries exception text. `shared/api.py` returns a
  ServiceError's message verbatim, so `f'...: {e}'` published boto detail (table
  and bucket names, key structure, request ids).

Kept in its own module, apart from test_data_explorer_handler.py, so it does not
collide with concurrent edits to that file.
"""
import json
import os
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import recording_logger

from shared.exceptions import ValidationError

# Planted in the fault text; whether it comes back out is the question.
_SENTINEL = 'SECRET-arn:aws:iam::123456789012:role/internal'
# Read from the env conftest sets (the handler's own source), not copied: these
# feed ABSENCE assertions, where a stale literal would pass vacuously.
_INTERNAL_TABLE = os.environ['FEEDBACK_TABLE']
_INTERNAL_BUCKET = os.environ['RAW_DATA_BUCKET']
_LEAKS = (_SENTINEL, _INTERNAL_TABLE, _INTERNAL_BUCKET, 'InternalServerError', 'SOURCE#', 'FEEDBACK#')


def _aws_failure(operation: str) -> ClientError:
    """A ClientError shaped like boto's, whose text names internal resources."""
    return ClientError(
        {'Error': {
            'Code': 'InternalServerError',
            'Message': f'{_SENTINEL} on {_INTERNAL_TABLE}/{_INTERNAL_BUCKET} key pk=SOURCE#x sk=FEEDBACK#y',
        }},
        operation,
    )


def _s3_stub(mock_s3: MagicMock) -> None:
    # A real class, so `except s3_client.exceptions.NoSuchKey` is a valid clause
    # that does not match the injected fault.
    mock_s3.exceptions = MagicMock()
    mock_s3.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})


def _assert_no_leak(raw_body: str) -> None:
    for leak in _LEAKS:
        assert leak not in raw_body, f'{leak!r} must not reach the client; body was: {raw_body}'


_FAILING_ROUTES = [
    pytest.param({'method': 'GET', 'path': '/data-explorer/s3',
                  'query_params': {'bucket': 'raw-data'}}, 'Failed to list S3 objects', id='GET s3'),
    pytest.param({'method': 'GET', 'path': '/data-explorer/s3/preview',
                  'query_params': {'bucket': 'raw-data', 'key': 'webscraper/x.json'}},
                 'Failed to preview file', id='GET s3/preview'),
    pytest.param({'method': 'PUT', 'path': '/data-explorer/s3',
                  'body': {'bucket': 'raw-data', 'key': 'notes/a.json', 'content': '{}'}},
                 'Failed to save file', id='PUT s3'),
    pytest.param({'method': 'PUT', 'path': '/data-explorer/feedback',
                  'body': {'feedback_id': 'fb-1', 'data': {'original_text': 'edit'}}},
                 'Failed to update feedback', id='PUT feedback'),
]


class TestNoExceptionTextInResponses:

    @pytest.mark.parametrize(('event_kwargs', 'message'), _FAILING_ROUTES)
    def test_returns_fixed_500_message_and_logs_the_fault(
        self, event_kwargs, message, api_gateway_event, lambda_context
    ):
        mock_logger = recording_logger()
        with patch('data_explorer_handler.s3_client') as mock_s3, \
             patch('data_explorer_handler.dynamodb') as mock_dynamodb, \
             patch('data_explorer_handler.logger', mock_logger):
            _s3_stub(mock_s3)
            for method in ('list_objects_v2', 'head_object', 'get_object', 'put_object'):
                getattr(mock_s3, method).side_effect = _aws_failure('S3Call')
            mock_table = MagicMock()
            mock_dynamodb.Table.return_value = mock_table
            for method in ('query', 'get_item', 'update_item'):
                getattr(mock_table, method).side_effect = _aws_failure('DynamoCall')

            from data_explorer_handler import lambda_handler
            response = lambda_handler(api_gateway_event(**event_kwargs), lambda_context)

        assert response['statusCode'] == 500
        _assert_no_leak(response['body'])
        assert json.loads(response['body'])['error'] == message
        # Positive control: absent from the body, but recorded for an operator.
        assert _SENTINEL in ' '.join(mock_logger.emitted_exceptions)

    def test_bucket_stats_error_field_is_generic(self, api_gateway_event, lambda_context):
        """GET /stats reports a bucket failure inside a 200 body — without `str(e)`."""
        mock_logger = recording_logger()
        with patch('data_explorer_handler.s3_client') as mock_s3, \
             patch('data_explorer_handler.logger', mock_logger):
            mock_s3.list_objects_v2.side_effect = _aws_failure('ListObjectsV2')
            from data_explorer_handler import lambda_handler
            response = lambda_handler(api_gateway_event(method='GET', path='/data-explorer/stats'), lambda_context)

        assert response['statusCode'] == 200
        body = json.loads(response['body'])
        assert [b['error'] for b in body['s3']['buckets']] == ['Failed to read bucket contents']
        for leak in (_SENTINEL, 'InternalServerError', 'ListObjectsV2'):
            assert leak not in response['body']
        assert _SENTINEL in ' '.join(mock_logger.emitted_exceptions)


class TestPreviewMissingKey:
    """head_object raises a bare ClientError '404' for a missing key, never NoSuchKey."""

    @patch('data_explorer_handler.s3_client')
    def test_head_object_404_is_a_404(self, mock_s3, api_gateway_event, lambda_context):
        _s3_stub(mock_s3)
        mock_s3.head_object.side_effect = ClientError({'Error': {'Code': '404', 'Message': 'Not Found'}}, 'HeadObject')
        from data_explorer_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='GET', path='/data-explorer/s3/preview',
            query_params={'bucket': 'raw-data', 'key': 'gone.json'}), lambda_context)

        assert response['statusCode'] == 404
        assert json.loads(response['body'])['error'] == 'File not found'

    @patch('data_explorer_handler.s3_client')
    def test_other_client_errors_stay_a_generic_500(self, mock_s3, api_gateway_event, lambda_context):
        _s3_stub(mock_s3)
        mock_s3.head_object.side_effect = ClientError(
            {'Error': {'Code': 'AccessDenied', 'Message': f'{_SENTINEL} on {_INTERNAL_BUCKET}'}}, 'HeadObject')
        from data_explorer_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='GET', path='/data-explorer/s3/preview',
            query_params={'bucket': 'raw-data', 'key': 'forbidden.json'}), lambda_context)

        assert response['statusCode'] == 500
        _assert_no_leak(response['body'])
        assert 'AccessDenied' not in response['body']


class TestTypedErrorsKeepTheirStatus:

    @patch('data_explorer_handler.s3_client')
    def test_preview_validation_error_inside_try_stays_400(self, mock_s3, api_gateway_event, lambda_context):
        """A ValidationError raised inside preview's `try` must not become a 500."""
        _s3_stub(mock_s3)
        with patch('data_explorer_handler._object_preview', side_effect=ValidationError('Bad preview request')):
            from data_explorer_handler import lambda_handler
            response = lambda_handler(api_gateway_event(
                method='GET', path='/data-explorer/s3/preview',
                query_params={'bucket': 'raw-data', 'key': 'x.json'}), lambda_context)

        assert response['statusCode'] == 400
        assert json.loads(response['body'])['error'] == 'Bad preview request'

    @patch('data_explorer_handler.s3_client')
    def test_list_validation_error_inside_try_stays_400(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.list_objects_v2.side_effect = ValidationError('Bad listing request')
        from data_explorer_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='GET', path='/data-explorer/s3', query_params={'bucket': 'raw-data'}), lambda_context)

        assert response['statusCode'] == 400

    @patch('data_explorer_handler.dynamodb')
    def test_update_of_missing_feedback_stays_404(self, mock_dynamodb, api_gateway_event, lambda_context):
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': []}
        from data_explorer_handler import lambda_handler
        response = lambda_handler(api_gateway_event(
            method='PUT', path='/data-explorer/feedback',
            body={'feedback_id': 'ghost', 'data': {'original_text': 'edit'}}), lambda_context)

        assert response['statusCode'] == 404
        mock_table.update_item.assert_not_called()
