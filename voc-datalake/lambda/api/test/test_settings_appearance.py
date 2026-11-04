"""GET / PUT /settings/appearance: the workspace's start theme (shared/appearance_routes.py).

GET is open to every signed-in user (no row = ``kiro``); PUT is admin-only, refused before the
body is parsed or anything is written, and an unknown theme id is a 400.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

import settings_handler
from settings_handler import lambda_handler
from shared.appearance import APPEARANCE_PK, APPEARANCE_SK

USER = {'sub': 'user-sub', 'cognito:username': 'bob', 'cognito:groups': 'users'}
ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
PATH = '/settings/appearance'


@pytest.fixture
def table():
    mock = MagicMock()
    mock.get_item.return_value = {}
    with patch.object(settings_handler, 'aggregates_table', mock):
        yield mock


def _call(api_gateway_event, lambda_context, method, claims, body=None, raw_body=None):
    event = api_gateway_event(method=method, path=PATH, body=body, claims=claims)
    if raw_body is not None:
        event['body'] = raw_body
    response = lambda_handler(event, lambda_context)
    return response['statusCode'], json.loads(response['body'])


def test_get_answers_the_default_when_nothing_is_stored(api_gateway_event, lambda_context, table):
    status, payload = _call(api_gateway_event, lambda_context, 'GET', USER)
    assert (status, payload) == (200, {'default_theme': 'kiro'})
    table.get_item.assert_called_once_with(Key={'pk': APPEARANCE_PK, 'sk': APPEARANCE_SK})


def test_get_answers_the_stored_theme_to_any_signed_in_user(api_gateway_event, lambda_context, table):
    table.get_item.return_value = {'Item': {'pk': APPEARANCE_PK, 'sk': APPEARANCE_SK, 'default_theme': 'dracula'}}
    status, payload = _call(api_gateway_event, lambda_context, 'GET', USER)
    assert (status, payload) == (200, {'default_theme': 'dracula'})


def test_an_admin_saves_the_default_theme(api_gateway_event, lambda_context, table):
    status, payload = _call(api_gateway_event, lambda_context, 'PUT', ADMIN, {'default_theme': 'nord'})
    assert status == 200
    assert payload == {'success': True, 'settings': {'default_theme': 'nord'}}
    item = table.put_item.call_args.kwargs['Item']
    assert (item['pk'], item['sk'], item['default_theme']) == (APPEARANCE_PK, APPEARANCE_SK, 'nord')
    assert item['updated_at']
    # Who changed it (tenet D4): the admin's stable Cognito sub, never part of the GET answer.
    assert item['updated_by'] == 'admin-sub'


def test_the_get_never_answers_who_saved_it(api_gateway_event, lambda_context, table):
    table.get_item.return_value = {'Item': {
        'pk': APPEARANCE_PK, 'sk': APPEARANCE_SK, 'default_theme': 'nord', 'updated_by': 'admin-sub',
    }}
    status, payload = _call(api_gateway_event, lambda_context, 'GET', USER)
    assert (status, payload) == (200, {'default_theme': 'nord'})


@pytest.mark.parametrize('body', [{'default_theme': 'solarized'}, {}, {'default_theme': None}])
def test_an_unknown_theme_is_a_400_and_nothing_is_written(api_gateway_event, lambda_context, table, body):
    status, payload = _call(api_gateway_event, lambda_context, 'PUT', ADMIN, body)
    assert status == 400
    assert 'default_theme must be one of' in json.dumps(payload)
    table.put_item.assert_not_called()


def test_a_non_admin_is_refused_before_the_body_is_read(api_gateway_event, lambda_context, table):
    status, payload = _call(api_gateway_event, lambda_context, 'PUT', USER, raw_body='{not json')
    assert status == 403
    assert payload['error'] == 'Admin access required'
    table.put_item.assert_not_called()


def test_without_a_table_the_get_is_a_configuration_error(api_gateway_event, lambda_context):
    with patch.object(settings_handler, 'aggregates_table', None):
        status, _ = _call(api_gateway_event, lambda_context, 'GET', USER)
    assert status >= 500
