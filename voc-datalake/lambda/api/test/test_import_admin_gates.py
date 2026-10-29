"""S3 import and manual import are admin-only, every route (owner decision 2026-10-08, #242 follow-up).

Both modules gate through one resolver middleware (`shared.api.admins_only`), so the refusal
must come BEFORE the route touches anything: a non-admin gets 403 and the S3, SQS,
DynamoDB and Lambda-invoke clients (the parse job's invoke is what reaches Bedrock)
see no call at all. An admin still reaches each route.

Reverting either module's `app.use(middlewares=[admins_only])` fails every
non-admin case here.
"""
import json
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

import manual_import_handler
import s3_import_handler

FORBIDDEN = (403, {'success': False, 'error': 'Admin access required'})

S3_IMPORT_ROUTES = [
    ('GET', '/s3-import/sources', {}),
    ('GET', '/s3-import/files', {}),
    ('POST', '/s3-import/sources', {'body': {'name': 'web'}}),
    ('POST', '/s3-import/upload-url', {'body': {'filename': 'a.csv', 'source': 'web'}}),
    ('DELETE', '/s3-import/file/web%2Fa.csv', {'path_params': {'key': 'web%2Fa.csv'}}),
]

MANUAL_IMPORT_ROUTES = [
    ('POST', '/scrapers/manual/parse', {'body': {'source_url': 'https://g2.com/x', 'raw_text': 'Great product'}}),
    ('GET', '/scrapers/manual/parse/job-1', {'path_params': {'job_id': 'job-1'}}),
    ('POST', '/scrapers/manual/confirm', {'body': {'job_id': 'job-1', 'reviews': []}}),
    ('POST', '/scrapers/manual/csv-upload', {'body': {'csv': 'text\nhello\n'}}),
    ('POST', '/scrapers/manual/json-upload', {'body': {'items': [{'text': 'hello'}]}}),
    ('GET', '/scrapers/manual/history', {}),
    ('GET', '/scrapers/manual/history/0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e',
     {'path_params': {'run_id': '0b1f3c4e-7a2d-4f6b-9c8e-1d2a3b4c5d6e'}}),
]


def _as(api_gateway_event, groups: str, **kwargs) -> dict:
    event = api_gateway_event(**kwargs)
    event['requestContext']['authorizer']['claims']['cognito:groups'] = groups
    return event


def _run(handler, api_gateway_event, lambda_context, groups: str, method: str, path: str, kwargs: dict):
    """Call *handler* as a caller whose only Cognito group claim is *groups*; `(status, decoded body)`."""
    response = handler(_as(api_gateway_event, groups, method=method, path=path, **kwargs), lambda_context)
    return response['statusCode'], json.loads(response['body'])


@pytest.fixture
def s3_import() -> Iterator[MagicMock]:
    with patch.object(s3_import_handler, 's3_client') as client, \
            patch.object(s3_import_handler, 'S3_IMPORT_BUCKET', 'import-bucket'):
        client.head_object.side_effect = ClientError({'Error': {'Code': '404'}}, 'HeadObject')
        client.list_objects_v2.return_value = {'CommonPrefixes': []}
        client.get_paginator.return_value.paginate.return_value = []
        client.generate_presigned_url.return_value = 'https://s3.example.com/put'
        yield client


@pytest.fixture
def manual_import() -> Iterator[dict[str, MagicMock]]:
    h = manual_import_handler
    with patch.object(h, 's3') as s3, patch.object(h, 'sqs') as sqs, \
            patch.object(h, 'aggregates_table') as table, patch.object(h, 'invoke_lambda_async') as invoke:
        yield {'s3': s3, 'sqs': sqs, 'aggregates_table': table, 'invoke_lambda_async': invoke}


class TestANonAdminIsRefusedBeforeAnyAwsCall:
    @pytest.mark.parametrize('groups', ['users', ''])
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), S3_IMPORT_ROUTES)
    def test_s3_import(self, s3_import, api_gateway_event, lambda_context, groups, method, path, kwargs):
        assert _run(s3_import_handler.lambda_handler, api_gateway_event, lambda_context,
                    groups, method, path, kwargs) == FORBIDDEN
        assert s3_import.mock_calls == []

    @pytest.mark.parametrize('groups', ['users', ''])
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), MANUAL_IMPORT_ROUTES)
    def test_manual_import(self, manual_import, api_gateway_event, lambda_context, groups, method, path, kwargs):
        assert _run(manual_import_handler.lambda_handler, api_gateway_event, lambda_context,
                    groups, method, path, kwargs) == FORBIDDEN
        assert {name: client.mock_calls for name, client in manual_import.items()} == {
            name: [] for name in manual_import}


class TestAnAdminReachesEveryRoute:
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), S3_IMPORT_ROUTES)
    def test_s3_import(self, s3_import, api_gateway_event, lambda_context, method, path, kwargs):
        status, _ = _run(s3_import_handler.lambda_handler, api_gateway_event, lambda_context,
                         'admins', method, path, kwargs)
        assert status == 200
        assert s3_import.mock_calls != []

    @pytest.mark.usefixtures('manual_import')
    @pytest.mark.parametrize(('method', 'path', 'kwargs'), MANUAL_IMPORT_ROUTES)
    def test_manual_import_is_past_the_gate(self, api_gateway_event, lambda_context, method, path, kwargs):
        """Past the gate means the route's own logic answered, whatever it answered — never the 403."""
        status, body = _run(manual_import_handler.lambda_handler, api_gateway_event, lambda_context,
                            'admins', method, path, kwargs)
        assert (status, body) != FORBIDDEN
