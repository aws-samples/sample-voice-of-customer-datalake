"""
Tests for data_explorer_handler.py - /data-explorer/* endpoints.
Full CRUD for S3 raw data and DynamoDB feedback.
"""
import json
import pytest
from unittest.mock import patch, MagicMock
from decimal import Decimal

from botocore.exceptions import ClientError


# A string no legitimate response body has any reason to contain, planted in the
# text of the AWS fault the handler catches. Whether it comes back out is the whole
# question in TestErrorDisclosure below: `shared/api.py` returns a ServiceError's
# `.message` verbatim, so an `f'...: {str(e)}'` message published it (issue #263).
_SENTINEL = 'SENTINEL_INTERNAL_DETAIL'

# The two internal names a botocore fault realistically drags along on these
# routes, both of which are in this handler's own configuration: the DynamoDB table
# and the S3 bucket (conftest sets both env vars).
_INTERNAL_TABLE = 'test-feedback'
_INTERNAL_BUCKET = 'test-raw-data-bucket'


def _aws_failure(operation: str) -> ClientError:
    """An AWS client error whose message carries internal detail.

    Shaped like the real thing: botocore's ``str()`` includes the error code, the
    message and the operation name, so interpolating it into a client-facing
    message leaks all three plus whatever the service put in the text — here the
    table and bucket names.
    """
    return ClientError(
        {'Error': {
            'Code': 'InternalServerError',
            'Message': f'{_SENTINEL} on {_INTERNAL_TABLE}/{_INTERNAL_BUCKET} key pk=SOURCE#x sk=FEEDBACK#y',
        }},
        operation,
    )


# Every route in this handler that answers an AWS failure with a 500, as
# (route description, event kwargs). Exercised as a set rather than through one
# representative case: the leak was per-route, so one fixed route proves nothing
# about the next.
_DISCLOSURE_ROUTES = [
    ('GET /data-explorer/s3', {
        'method': 'GET', 'path': '/data-explorer/s3',
        'query_params': {'bucket': 'raw-data'}}),
    ('GET /data-explorer/s3/preview', {
        'method': 'GET', 'path': '/data-explorer/s3/preview',
        'query_params': {'bucket': 'raw-data', 'key': 'webscraper/x.json'}}),
    ('PUT /data-explorer/s3', {
        'method': 'PUT', 'path': '/data-explorer/s3',
        'body': {'bucket': 'raw-data', 'key': 'a.json', 'content': '{}'}}),
    ('DELETE /data-explorer/s3', {
        'method': 'DELETE', 'path': '/data-explorer/s3',
        'query_params': {'bucket': 'raw-data', 'key': 'a.json'}}),
    ('PUT /data-explorer/feedback', {
        'method': 'PUT', 'path': '/data-explorer/feedback',
        'body': {'feedback_id': 'fb-1', 'data': {'original_text': 'edit'}}}),
    ('DELETE /data-explorer/feedback', {
        'method': 'DELETE', 'path': '/data-explorer/feedback',
        'query_params': {'feedback_id': 'fb-1'}}),
]


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
    def test_lookup_queries_the_real_gsi_name(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Regression (#140): the feedback-id lookup must query the GSI that
        actually exists on the table (gsi4-by-feedback-id, core-stack.ts) —
        'feedback-id-index' does not exist and made every non-key edit 500."""
        # Arrange — no pk/sk in data forces the GSI lookup path
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {
            'Items': [{'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#fb-123'}]
        }
        mock_table.update_item.return_value = {}

        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/feedback',
            body={
                'feedback_id': 'fb-123',
                'data': {'original_text': 'Updated via GSI lookup'}
            }
        )

        # Act
        response = lambda_handler(event, lambda_context)

        # Assert
        assert response['statusCode'] == 200
        mock_table.query.assert_called_once()
        assert mock_table.query.call_args.kwargs['IndexName'] == 'gsi4-by-feedback-id'

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


    @patch('data_explorer_handler.dynamodb')
    def test_returns_400_when_no_editable_fields_supplied(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Returns 400, not 500, when the payload carries no updatable field.

        Regression (#263): `ValidationError('No fields to update')` is raised
        INSIDE save_feedback's broad `try`, whose `except Exception` rewrapped it
        as a ServiceError — so a client's bad request came back as a 500 and it
        could not tell its own mistake from an outage.
        """
        # Arrange — source_platform is real data but not an updatable field, so the
        # update expression ends up empty.
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/feedback',
            body={
                'feedback_id': 'fb-123',
                'data': {'source_platform': 'webscraper', 'not_updatable': 'x'},
            }
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 400
        assert 'no fields to update' in body['error'].lower()
        # Nothing was written: the refusal happens before any update_item.
        mock_table.update_item.assert_not_called()

    @patch('data_explorer_handler.dynamodb')
    def test_returns_404_when_updating_missing_feedback(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Returns 404, not 500, when the feedback record does not exist.

        Regression (#263): `NotFoundError('Feedback not found')` sat inside the
        same broad `try` as above, so an edit of a deleted record answered 500.
        """
        # Arrange — no source_platform forces the GSI lookup, which finds nothing.
        mock_table = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_table.query.return_value = {'Items': []}

        from data_explorer_handler import lambda_handler
        event = api_gateway_event(
            method='PUT',
            path='/data-explorer/feedback',
            body={'feedback_id': 'ghost', 'data': {'original_text': 'edit'}}
        )

        # Act
        response = lambda_handler(event, lambda_context)
        body = json.loads(response['body'])

        # Assert
        assert response['statusCode'] == 404
        assert 'not found' in body['error'].lower()
        mock_table.update_item.assert_not_called()


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
    def test_delete_queries_the_real_gsi_name(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Regression (#140): delete's feedback-id lookup must use
        gsi4-by-feedback-id — the nonexistent 'feedback-id-index' made every
        Data Explorer record delete fail with a ValidationException."""
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

        # Assert
        assert response['statusCode'] == 200
        mock_table.query.assert_called_once()
        assert mock_table.query.call_args.kwargs['IndexName'] == 'gsi4-by-feedback-id'

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


class TestErrorDisclosure:
    """Regression (#263): a client-facing error body must carry no internal detail.

    `shared/api.py` renders `ServiceError.message` straight into the response, so
    every `raise ServiceError(f'...: {str(e)}')` in this handler published boto
    text — table name, pk/sk structure, bucket name, request id — to anyone who
    could provoke a 500. These tests plant a sentinel plus the real table and
    bucket names in the fault and assert none of the three comes back.
    """

    @pytest.mark.parametrize(
        'event_kwargs',
        [pytest.param(kwargs, id=name) for name, kwargs in _DISCLOSURE_ROUTES]
    )
    def test_returns_generic_500_without_internal_detail(
        self, event_kwargs, api_gateway_event, lambda_context
    ):
        """Returns a 500 whose body names no table, bucket, key or boto text."""
        # Arrange — fail whichever AWS call the route makes.
        with patch('data_explorer_handler.s3_client') as mock_s3, \
             patch('data_explorer_handler.dynamodb') as mock_dynamodb, \
             patch('data_explorer_handler.logger') as mock_logger:
            # A real exception class, so the `except s3_client.exceptions.NoSuchKey`
            # clause on the preview route is catchable and does not match.
            mock_s3.exceptions = MagicMock()
            mock_s3.exceptions.NoSuchKey = type('NoSuchKey', (Exception,), {})
            for method in ('list_objects_v2', 'head_object', 'get_object',
                           'put_object', 'delete_object'):
                getattr(mock_s3, method).side_effect = _aws_failure('S3Call')

            mock_table = MagicMock()
            mock_dynamodb.Table.return_value = mock_table
            for method in ('query', 'update_item', 'delete_item'):
                getattr(mock_table, method).side_effect = _aws_failure('DynamoCall')

            from data_explorer_handler import lambda_handler
            event = api_gateway_event(**event_kwargs)

            # Act
            response = lambda_handler(event, lambda_context)
            raw_body = response['body']

            # Assert
            assert response['statusCode'] == 500
            for leak in (_SENTINEL, _INTERNAL_TABLE, _INTERNAL_BUCKET,
                         'InternalServerError', 'SOURCE#', 'FEEDBACK#'):
                assert leak not in raw_body, (
                    f'{leak!r} must not reach the client; body was: {raw_body}'
                )
            # The message is still useful to a human, so "no detail" was not
            # achieved by returning an empty string.
            assert json.loads(raw_body)['error'].startswith('Failed to ')

            # Positive control: without this, "absent from the body" would also
            # hold for a fault that was swallowed and never recorded.
            logged = ' '.join(str(c.args) for c in mock_logger.exception.call_args_list)
            assert _SENTINEL in logged, (
                f'the fault must be logged for an operator; exception() calls: {logged}'
            )

    def test_bucket_stats_error_field_omits_internal_detail(
        self, api_gateway_event, lambda_context
    ):
        """GET /stats reports a bucket failure without echoing the boto text.

        This one rides inside a 200 body rather than an error response, which is
        exactly why it was missed: `bucket_info['error'] = str(e)` leaked the same
        detail as a ServiceError message would.
        """
        # Arrange
        with patch('data_explorer_handler.s3_client') as mock_s3, \
             patch('data_explorer_handler.logger') as mock_logger:
            mock_s3.list_objects_v2.side_effect = _aws_failure('ListObjectsV2')

            from data_explorer_handler import lambda_handler
            event = api_gateway_event(method='GET', path='/data-explorer/stats')

            # Act
            response = lambda_handler(event, lambda_context)
            raw_body = response['body']
            body = json.loads(raw_body)

            # Assert — the failure is reported, but only in the abstract.
            assert response['statusCode'] == 200
            reported = [b for b in body['s3']['buckets'] if b.get('error')]
            assert reported, f'the bucket failure must still be reported: {raw_body}'
            for leak in (_SENTINEL, 'InternalServerError'):
                assert leak not in raw_body, (
                    f'{leak!r} must not reach the client; body was: {raw_body}'
                )

            logged = ' '.join(str(c.args) for c in mock_logger.exception.call_args_list)
            assert _SENTINEL in logged, (
                f'the fault must be logged for an operator; exception() calls: {logged}'
            )


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
