"""
Tests for data_explorer_handler.py - /data-explorer/* endpoints.
Admin-only browser: S3 raw data is write-once, nothing is ever deleted.

The per-route literals (messages, call arguments, listing rules) live in
`test_data_explorer_handler_mutation.py`; this file keeps the invariants that
cut across routes: the storage boundaries, the absence of any delete, the
admin gate, and the #140 index-name regression.
"""
import json
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from handler_events_fixtures import call_route, table_behind

from shared.test.source_profile_fixtures import no_source_profiles

# The raw-key writes resolve their source's PII policy strictly; serve "none configured".
_no_profiles = pytest.fixture(autouse=True)(no_source_profiles)


class TestSaveFeedback:
    """Tests for PUT /data-explorer/feedback endpoint."""

    @patch('data_explorer_handler.dynamodb')
    def test_lookup_queries_the_real_gsi_name(
        self, mock_dynamodb, api_gateway_event, lambda_context
    ):
        """Regression (#140): the feedback-id lookup must query the GSI that
        actually exists on the table (gsi4-by-feedback-id, core-stack.ts) —
        'feedback-id-index' does not exist and made every non-key edit 500."""
        # Arrange — no pk/sk in data forces the GSI lookup path
        mock_table = table_behind(mock_dynamodb)
        mock_table.query.return_value = {
            'Items': [{'pk': 'SOURCE#webscraper', 'sk': 'FEEDBACK#fb-123'}]
        }
        mock_table.update_item.return_value = {}

        from data_explorer_handler import lambda_handler
        # Act
        response, _ = call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT',
            path='/data-explorer/feedback',
            body={
                'feedback_id': 'fb-123',
                'data': {'original_text': 'Updated via GSI lookup'}
            },
        )

        # Assert
        assert response['statusCode'] == 200
        mock_table.query.assert_called_once()
        assert mock_table.query.call_args.kwargs['IndexName'] == 'gsi4-by-feedback-id'


class TestGeneratedPrototypeStorageBoundary:
    @patch('data_explorer_handler.s3_client')
    def test_prototype_prefix_remains_browsable(
        self, mock_s3, api_gateway_event, lambda_context,
    ):
        mock_s3.list_objects_v2.return_value = {
            'CommonPrefixes': [],
            'Contents': [],
        }

        from data_explorer_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(
                method='GET',
                path='/data-explorer/s3',
                query_params={'bucket': 'raw-data', 'prefix': 'prototypes'},
            ),
            lambda_context,
        )

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['prefix'] == 'prototypes'
        assert mock_s3.list_objects_v2.call_args.kwargs['Prefix'] == 'prototypes/'

    @patch('data_explorer_handler.s3_client')
    def test_prototype_html_remains_previewable(
        self, mock_s3, api_gateway_event, lambda_context,
    ):
        prototype = '<html><body>generated</body></html>'
        mock_s3.head_object.return_value = {
            'ContentLength': len(prototype),
            'ContentType': 'text/html',
        }
        body = MagicMock()
        body.read.return_value = prototype.encode('utf-8')
        mock_s3.get_object.return_value = {'Body': body}

        from data_explorer_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(
                method='GET',
                path='/data-explorer/s3/preview',
                query_params={
                    'bucket': 'raw-data',
                    'key': 'prototypes/p1/prototype-1.html',
                },
            ),
            lambda_context,
        )

        assert response['statusCode'] == 200
        assert json.loads(response['body'])['content'] == prototype
        mock_s3.get_object.assert_called_once()

    @patch('data_explorer_handler.RAW_DATA_BUCKET', 'test-raw-data')
    @patch('data_explorer_handler.dynamodb')
    @patch('data_explorer_handler.s3_client')
    def test_a_feedback_edit_never_writes_back_to_s3(
        self, mock_s3, mock_dynamodb, api_gateway_event, lambda_context,
    ):
        """`sync_to_s3` is retired: raw data is immutable, so even a caller still
        sending it edits only the DynamoDB record."""
        mock_table = table_behind(mock_dynamodb)
        from data_explorer_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(
                method='PUT',
                path='/data-explorer/feedback',
                body={
                    'feedback_id': 'fb-1',
                    'sync_to_s3': True,
                    'data': {
                        'source_platform': 'webscraper',
                        'original_text': 'edited',
                        's3_raw_uri': 's3://test-raw-data/raw/webscraper/2026/01/01/fb-1.json',
                    },
                },
            ),
            lambda_context,
        )

        assert response['statusCode'] == 200
        assert 'synced' not in json.loads(response['body'])
        mock_table.update_item.assert_called_once()
        mock_s3.put_object.assert_not_called()


class TestNothingIsDeleted:
    """The data lake never deletes: no DELETE route exists for S3 or feedback."""

    @pytest.mark.parametrize(('path', 'params'), [
        ('/data-explorer/s3', {'bucket': 'raw-data', 'key': 'raw/webscraper/x.json'}),
        ('/data-explorer/feedback', {'feedback_id': 'fb-1'}),
    ])
    @patch('data_explorer_handler.dynamodb')
    @patch('data_explorer_handler.s3_client')
    def test_delete_routes_are_gone(
        self, mock_s3, mock_dynamodb, path, params, api_gateway_event, lambda_context,
    ):
        from data_explorer_handler import lambda_handler

        response = lambda_handler(
            api_gateway_event(method='DELETE', path=path, query_params=params),
            lambda_context,
        )

        assert response['statusCode'] in (404, 405)
        mock_s3.delete_object.assert_not_called()
        mock_dynamodb.Table.return_value.delete_item.assert_not_called()

    def test_the_handler_never_calls_a_delete_api(self):
        source = (Path(__file__).resolve().parents[1] / 'data_explorer_handler.py').read_text(encoding='utf-8')
        assert 'delete_object' not in source
        assert 'delete_item' not in source
        assert '@app.delete' not in source


class TestRawObjectsAreWriteOnce:
    """`PUT /data-explorer/s3` never overwrites an object under `raw/`."""

    @staticmethod
    def _put(api_gateway_event, lambda_context, key):
        from data_explorer_handler import lambda_handler

        return call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='PUT', path='/data-explorer/s3',
            body={'bucket': 'raw-data', 'key': key, 'content': {'text': 'x'}},
        )

    @pytest.mark.parametrize('code', ['PreconditionFailed', 'ConditionalRequestConflict'])
    @patch('data_explorer_handler.s3_client')
    def test_an_existing_raw_object_is_a_409(self, mock_s3, code, api_gateway_event, lambda_context):
        mock_s3.put_object.side_effect = ClientError(
            {'Error': {'Code': code, 'Message': 'exists'}}, 'PutObject')
        response, body = self._put(api_gateway_event, lambda_context, 'raw/webscraper/2026/01/01/a.json')

        assert response['statusCode'] == 409
        assert 'immutable' in body['error']

    @patch('data_explorer_handler.s3_client')
    def test_any_other_s3_failure_is_a_500(self, mock_s3, api_gateway_event, lambda_context):
        mock_s3.put_object.side_effect = ClientError(
            {'Error': {'Code': 'AccessDenied', 'Message': 'no'}}, 'PutObject')
        response, _ = self._put(api_gateway_event, lambda_context, 'raw/webscraper/a.json')

        assert response['statusCode'] == 500


class TestEveryRouteIsAdminOnly:
    """Raw S3 cannot be filtered by category, so the explorer is admins-only."""

    ROUTES: ClassVar[list[tuple[str, str, dict[str, str] | None, dict[str, object] | None]]] = [
        ('GET', '/data-explorer/s3', {'bucket': 'raw-data'}, None),
        ('GET', '/data-explorer/s3/preview', {'bucket': 'raw-data', 'key': 'raw/a.json'}, None),
        ('PUT', '/data-explorer/s3', None, {'bucket': 'raw-data', 'key': 'raw/a.json', 'content': 'x'}),
        ('PUT', '/data-explorer/feedback', None, {'feedback_id': 'fb-1', 'data': {'original_text': 'x'}}),
        ('GET', '/data-explorer/buckets', None, None),
        ('GET', '/data-explorer/stats', None, None),
    ]

    def test_the_list_covers_every_declared_route(self):
        import re

        source = (Path(__file__).resolve().parents[1] / 'data_explorer_handler.py').read_text(encoding='utf-8')
        declared = set(re.findall(r'@app\.(get|put|post|patch)\("([^"]+)"\)', source))
        covered = {(method.lower(), path) for method, path, _, _ in self.ROUTES}
        assert declared == covered

    @pytest.mark.parametrize(('method', 'path', 'params', 'body'), ROUTES)
    @patch('data_explorer_handler.dynamodb')
    @patch('data_explorer_handler.s3_client')
    def test_a_non_admin_is_refused_before_any_read_or_write(
        self, mock_s3, mock_dynamodb, method, path, params, body, api_gateway_event, lambda_context,
    ):
        from data_explorer_handler import lambda_handler

        event = api_gateway_event(method=method, path=path, query_params=params, body=body)
        event['requestContext']['authorizer']['claims']['cognito:groups'] = 'users'
        response = lambda_handler(event, lambda_context)

        assert response['statusCode'] == 403
        assert mock_s3.mock_calls == []
        assert mock_dynamodb.mock_calls == []
