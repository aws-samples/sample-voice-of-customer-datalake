"""POST /settings/design-system/references refuses an address that is already a reference (409).

Before 5.35.01 the same website added twice was accepted and read twice (two billed browser sessions
and two model calls). Archived references do not count: archiving and adding again is allowed.
"""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
ROUTE = '/settings/design-system/references'


@pytest.fixture
def invoke():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        with patch.object(settings_handler, 'aggregates_table', table), \
                patch.object(settings_handler, 'DESIGN_CAPTURE_FUNCTION', 'voc-design-capture'), \
                patch.object(settings_handler, 'validate_url', return_value=(True, '')), \
                patch.object(settings_handler, 'invoke_lambda_async') as mock_invoke, \
                patch.dict('os.environ', {'AWS_LAMBDA_FUNCTION_NAME': 'voc-settings-api'}):
            yield mock_invoke


def _add(api_gateway_event, lambda_context, url, kind='website', title='Site'):
    return call_route(lambda_handler, api_gateway_event, lambda_context, method='POST', path=ROUTE,
                      body={'kind': kind, 'title': title, 'url': url}, claims=ADMIN)


@pytest.mark.parametrize('again', [
    'https://www.kiromail.dev', 'https://WWW.KIROMAIL.DEV/', 'HTTPS://www.kiromail.dev:443/#pricing',
    '  https://www.kiromail.dev/  ',
])
def test_the_same_website_twice_is_refused_naming_the_existing_reference(api_gateway_event, lambda_context, invoke, again):
    response, _ = _add(api_gateway_event, lambda_context, 'https://www.kiromail.dev', title='Kiro Mail')
    assert response['statusCode'] == 201

    response, body = _add(api_gateway_event, lambda_context, again, title='Kiro Mail again')

    assert response['statusCode'] == 409
    assert '"Kiro Mail"' in body['error']
    assert 'Fetch again' in body['error']
    assert invoke.call_count == 1   # no second browser session


def test_a_github_repository_twice_is_refused(api_gateway_event, lambda_context, invoke):
    _add(api_gateway_event, lambda_context, 'https://github.com/acme/ui', kind='github', title='Repo')
    response, body = _add(api_gateway_event, lambda_context, 'https://GitHub.com/acme/ui/', kind='github', title='Repo 2')
    assert response['statusCode'] == 409
    assert '"Repo"' in body['error']
    assert invoke.call_count == 1


@pytest.mark.parametrize('other', ['https://www.kiromail.dev/pricing', 'https://www.kiromail.dev/?page=2',
                                   'https://kiromail.dev', 'https://www.kiromail.dev:8443/'])
def test_another_page_query_host_or_port_is_another_reference(api_gateway_event, lambda_context, invoke, other):
    _add(api_gateway_event, lambda_context, 'https://www.kiromail.dev')
    response, _ = _add(api_gateway_event, lambda_context, other)
    assert response['statusCode'] == 201
    assert invoke.call_count == 2


def test_an_archived_reference_can_be_added_again(api_gateway_event, lambda_context, invoke):
    _, created = _add(api_gateway_event, lambda_context, 'https://www.kiromail.dev')
    call_route(lambda_handler, api_gateway_event, lambda_context, method='DELETE',
               path=f'{ROUTE}/{created["reference"]["id"]}', claims=ADMIN)
    response, _ = _add(api_gateway_event, lambda_context, 'https://www.kiromail.dev/')
    assert response['statusCode'] == 201
    assert invoke.call_count == 2
