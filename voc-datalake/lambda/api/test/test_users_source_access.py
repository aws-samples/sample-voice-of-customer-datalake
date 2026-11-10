"""PUT/GET /users/{u}/category-access: the `sources` grant (KVD contract)."""
from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest
from category_access_fixtures import aggregates_with
from handler_events_fixtures import call_route

import users_handler
from shared.category_access import access_key

CONFIG_ROW = {'pk': 'SETTINGS#categories', 'sk': 'config', 'categories': [{'name': 'billing'}]}
SOURCES_ROW = {'pk': 'SETTINGS#sources', 'sk': 'config',
               'sources': [{'id': 'support_tickets', 'restricted': True}, {'id': 'sales_csv'}]}


@pytest.fixture
def cognito() -> Iterator[MagicMock]:
    mock = MagicMock()
    mock.admin_get_user.return_value = {'UserAttributes': [{'Name': 'sub', 'Value': 'sub-alice'}]}
    with patch.object(users_handler, 'cognito', mock):
        yield mock


def _wired(*rows: dict) -> MagicMock:
    return aggregates_with(CONFIG_ROW, SOURCES_ROW, *rows)


def _call(api_gateway_event, lambda_context, table: MagicMock, method: str, body: dict | None = None):
    with patch.object(users_handler, 'aggregates_table', table):
        response, decoded = call_route(users_handler.lambda_handler, api_gateway_event, lambda_context,
                                       method=method, path='/users/alice/category-access', body=body)
    return response['statusCode'], decoded


def _put(api_gateway_event, lambda_context, table: MagicMock, body: dict):
    return _call(api_gateway_event, lambda_context, table, 'PUT', body)


def _get(api_gateway_event, lambda_context, table: MagicMock):
    return _call(api_gateway_event, lambda_context, table, 'GET')


@pytest.mark.usefixtures('cognito')
@pytest.mark.parametrize('sources', [['*'], ['support_tickets'], []])
def test_a_valid_grant_is_stored_and_returned(api_gateway_event, lambda_context, sources):
    table = _wired()
    status, decoded = _put(api_gateway_event, lambda_context, table, {'categories': ['*'], 'sources': sources})
    assert (status, decoded['sources']) == (200, sources)
    assert table.put_item.call_args.kwargs['Item']['sources'] == sources


@pytest.mark.usefixtures('cognito')
@pytest.mark.parametrize(('sources', 'message'), [
    (['nope'], '1 sources are not configured'),
    ('support_tickets', "sources must be a list of source ids or ['*']"),
])
def test_an_invalid_grant_is_400(api_gateway_event, lambda_context, sources, message):
    table = _wired()
    status, decoded = _put(api_gateway_event, lambda_context, table, {'categories': ['*'], 'sources': sources})
    assert (status, decoded['error']) == (400, message)
    table.put_item.assert_not_called()


@pytest.mark.usefixtures('cognito')
def test_omitting_sources_keeps_the_stored_grant(api_gateway_event, lambda_context):
    table = _wired({**access_key('sub-alice'), 'categories': ['*'], 'sources': ['sales_csv']})
    status, decoded = _put(api_gateway_event, lambda_context, table, {'categories': ['billing']})
    assert (status, decoded['sources']) == (200, ['sales_csv'])
    assert table.put_item.call_args.kwargs['Item']['sources'] == ['sales_csv']


@pytest.mark.usefixtures('cognito')
@pytest.mark.parametrize(('stored', 'body'), [
    # omitted without a stored grant: stays the default
    ((), {'categories': ['billing']}),
    # null clears a stored list back to the default rule
    (({**access_key('sub-alice'), 'categories': ['*'], 'sources': ['support_tickets']},),
     {'categories': ['*'], 'sources': None}),
])
def test_the_default_rule_stores_no_sources(api_gateway_event, lambda_context, stored, body):
    table = _wired(*stored)
    status, decoded = _put(api_gateway_event, lambda_context, table, body)
    assert (status, decoded['sources']) == (200, None)
    assert 'sources' not in table.put_item.call_args.kwargs['Item']


@pytest.mark.usefixtures('cognito')
def test_a_corrupt_profiles_row_is_a_500(api_gateway_event, lambda_context):
    table = aggregates_with(CONFIG_ROW, {**SOURCES_ROW, 'sources': [{'id': 'BAD ID'}]})
    status, _ = _put(api_gateway_event, lambda_context, table, {'categories': ['*'], 'sources': ['x']})
    assert status == 500
    table.put_item.assert_not_called()


@pytest.mark.usefixtures('cognito')
def test_get_without_a_stored_grant_returns_null_sources(api_gateway_event, lambda_context):
    status, decoded = _get(api_gateway_event, lambda_context, _wired({**access_key('sub-alice'), 'categories': ['billing']}))
    assert (status, decoded['sources']) == (200, None)
