"""`PUT /settings/brand` and `POST /settings/categories/generate` are admin-only.

#242: the brand profile is shared deployment
configuration every AI surface reads, and category generation spends Bedrock to
feed the admin-only categories editor. A non-admin is refused with 403 BEFORE
the body is parsed, anything is written or Bedrock is called; an admin keeps
both routes; `GET /settings/brand` stays open to every signed-in user.
"""
import json
from unittest.mock import MagicMock, patch

import pytest
from assist_worker_fixtures import inline_assist_worker, start_and_poll

import settings_handler
from settings_handler import lambda_handler

USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
NO_GROUPS = {'sub': 'user-sub', 'cognito:username': 'bob'}
ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
GATED = [
    ('PUT', '/settings/brand', {'brand_name': 'Acme'}),
    ('POST', '/settings/categories/generate', {'company_description': 'We sell running shoes.'}),
]


@pytest.fixture
def table():
    mock = MagicMock()
    mock.get_item.return_value = {'Item': {'brand_name': 'Acme', 'brand_handles': [], 'hashtags': [],
                                           'urls_to_track': []}}
    with patch.object(settings_handler, 'aggregates_table', mock):
        yield mock


@pytest.fixture
def converse():
    with patch('shared.converse.converse', return_value='{"categories": []}') as mock:
        yield mock


def _call(api_gateway_event, lambda_context, method, path, body, claims, raw_body=None):
    event = api_gateway_event(method=method, path=path, body=body, claims=claims)
    if raw_body is not None:
        event['body'] = raw_body
    response = lambda_handler(event, lambda_context)
    return response, json.loads(response['body'])


@pytest.mark.parametrize('claims', [USER, NO_GROUPS], ids=['users-group', 'no-groups'])
@pytest.mark.parametrize(('method', 'path', 'body'), GATED, ids=['brand-put', 'categories-generate'])
def test_a_non_admin_is_refused_and_nothing_is_written_or_generated(
        api_gateway_event, lambda_context, table, converse, method, path, body, claims):
    response, payload = _call(api_gateway_event, lambda_context, method, path, body, claims)
    assert response['statusCode'] == 403
    assert payload['error'] == 'Admin access required'
    table.put_item.assert_not_called()
    converse.assert_not_called()


@pytest.mark.usefixtures('table', 'converse')
@pytest.mark.parametrize(('method', 'path', 'body'), GATED, ids=['brand-put', 'categories-generate'])
def test_the_refusal_comes_before_the_body_is_parsed(api_gateway_event, lambda_context, method, path, body):
    response, _ = _call(api_gateway_event, lambda_context, method, path, body, USER, raw_body='{not json')
    assert response['statusCode'] == 403


def test_the_refusal_comes_before_the_table_is_consulted(api_gateway_event, lambda_context):
    with patch.object(settings_handler, 'aggregates_table', None):
        response, _ = _call(api_gateway_event, lambda_context, 'PUT', '/settings/brand', {'brand_name': 'x'}, USER)
    assert response['statusCode'] == 403


def test_an_admin_saves_the_brand(api_gateway_event, lambda_context, table):
    response, payload = _call(api_gateway_event, lambda_context, 'PUT', '/settings/brand',
                              {'brand_name': 'Acme'}, ADMIN)
    assert response['statusCode'] == 200
    assert payload['settings']['brand_name'] == 'Acme'
    table.put_item.assert_called_once()


@pytest.mark.usefixtures('table')
def test_an_admin_generates_categories(api_gateway_event, lambda_context, converse):
    with inline_assist_worker(settings_handler, lambda_context):
        status, _, polled = start_and_poll(
            settings_handler, api_gateway_event, lambda_context, path='/settings/categories/generate',
            body={'company_description': 'We sell running shoes.'}, poll_prefix='/settings/jobs', claims=ADMIN)
    assert status == 202
    assert polled['result'] == {'success': True, 'categories': []}
    converse.assert_called_once()


@pytest.mark.usefixtures('table')
def test_every_signed_in_user_still_reads_the_brand(api_gateway_event, lambda_context):
    response, payload = _call(api_gateway_event, lambda_context, 'GET', '/settings/brand', None, USER)
    assert response['statusCode'] == 200
    assert payload['brand_name'] == 'Acme'
