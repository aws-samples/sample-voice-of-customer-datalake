"""Settings reads that carry category names obey the caller's category scope (owner rule 2026-10-21).

``GET /settings/company-context`` (the assistant's company brief, ``get_company_context``, MCP's
``get_company_context`` and the Company page) drops vision paragraphs and objectives that name a
hidden category; ``GET /settings/resolved-problems`` (the assistant's ``get_resolved_problems`` and
Problem Analysis) drops keys under a hidden category; ``GET /settings/design-system`` (the Design
system page, the assistant's ``get_design_system`` and the build dialog) drops guideline paragraphs,
tokens and references that name one. Admins and unrestricted users are unchanged.
"""
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from moto import mock_aws

import settings_handler
from settings_handler import lambda_handler
from shared.category_access import access_key
from shared.category_gate import CATEGORIES_PK, CATEGORIES_SK
from shared.company_context import COMPANY_CONTEXT_PK, CONFIG_SK, DESIGN_SYSTEM_PK
from shared.test.moto_tables import create_pk_sk_table

ADMIN = {'sub': 'admin-sub', 'cognito:username': 'alice', 'cognito:groups': 'admins'}
VIEWER = {'sub': 'viewer-sub', 'cognito:username': 'vic', 'cognito:groups': 'users'}
OPEN_USER = {'sub': 'open-sub', 'cognito:username': 'olga', 'cognito:groups': 'users'}
VISION = 'Customers trust us.\n\nHalve Hardware Quality returns this year.'
OBJECTIVES = [
    {'id': 'obj_000000000001', 'title': 'Answer support tickets within a day'},
    {'id': 'obj_000000000002', 'title': 'Stabilise firmware', 'description': 'Fewer Software & Firmware crashes'},
]
GUIDELINES = 'One primary action per screen.\n\nHardware Quality pages use the red banner.'
COMPONENTS = [
    {'name': 'Button', 'description': 'Primary action', 'variants': [{'name': 'primary', 'styles': {}}]},
    {'name': 'Recall banner', 'description': 'Shown on Hardware Quality pages', 'variants': []},
    {'name': 'Badge', 'description': '', 'variants': [{'name': 'software firmware', 'styles': {}}]},
]
RESOLVED = {
    'technical_support:response_time:slow replies': {'resolved_at': '2099-01-01T00:00:00+00:00'},
    'hardware_quality:hardware_failures:pump rattles': {'resolved_at': '2099-01-01T00:00:00+00:00'},
}


@pytest.fixture
def table():
    with mock_aws():
        table = create_pk_sk_table('test-aggregates')
        table.put_item(Item={'pk': CATEGORIES_PK, 'sk': CATEGORIES_SK, 'categories': [
            {'name': 'technical_support', 'description': 'Technical Support'},
            {'name': 'hardware_quality', 'description': 'Hardware Quality'},
            {'name': 'software_firmware', 'description': 'Software & Firmware'},
        ]})
        table.put_item(Item={'pk': COMPANY_CONTEXT_PK, 'sk': CONFIG_SK, 'vision': VISION, 'objectives': OBJECTIVES})
        table.put_item(Item={'pk': settings_handler.RESOLVED_PROBLEMS_PK, 'sk': settings_handler.RESOLVED_PROBLEMS_SK,
                             'resolved': RESOLVED})
        table.put_item(Item={'pk': DESIGN_SYSTEM_PK, 'sk': CONFIG_SK, 'guidelines': GUIDELINES, 'tokens': {
            'colors': [{'name': 'primary', 'value': '#8e48ff'}, {'name': 'hardware-quality', 'value': 'red'}]},
            'components': COMPONENTS})
        table.put_item(Item={**access_key(VIEWER['sub']), 'categories': ['technical_support']})
        with patch.object(settings_handler, 'aggregates_table', table):
            yield table


def _get(api_gateway_event, lambda_context, path, claims):
    response, body = call_route(lambda_handler, api_gateway_event, lambda_context, method='GET', path=path,
                                claims=claims)
    assert response['statusCode'] == 200, body
    return body


@pytest.mark.usefixtures('table')
def test_a_restricted_viewer_gets_company_context_without_hidden_category_names(api_gateway_event, lambda_context):
    body = _get(api_gateway_event, lambda_context, '/settings/company-context', VIEWER)
    assert body['vision'] == 'Customers trust us.'
    assert [o['title'] for o in body['objectives']] == ['Answer support tickets within a day']


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('claims', [ADMIN, OPEN_USER])
def test_admins_and_unrestricted_users_get_the_whole_company_context(api_gateway_event, lambda_context, claims):
    body = _get(api_gateway_event, lambda_context, '/settings/company-context', claims)
    assert (body['vision'], len(body['objectives'])) == (VISION, 2)


@pytest.mark.usefixtures('table')
def test_resolved_problems_under_a_hidden_category_are_not_listed(api_gateway_event, lambda_context):
    body = _get(api_gateway_event, lambda_context, '/settings/resolved-problems', VIEWER)
    assert list(body['resolved']) == ['technical_support:response_time:slow replies']


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('claims', [ADMIN, OPEN_USER])
def test_admins_and_unrestricted_users_see_every_resolved_problem(api_gateway_event, lambda_context, claims):
    body = _get(api_gateway_event, lambda_context, '/settings/resolved-problems', claims)
    assert sorted(body['resolved']) == sorted(RESOLVED)


@pytest.mark.usefixtures('table')
def test_a_restricted_viewer_gets_the_design_system_without_hidden_category_names(api_gateway_event, lambda_context):
    body = _get(api_gateway_event, lambda_context, '/settings/design-system', VIEWER)
    assert body['guidelines'] == 'One primary action per screen.'
    assert [c['name'] for c in body['tokens']['colors']] == ['primary']
    assert [c['name'] for c in body['components']] == ['Button']


@pytest.mark.usefixtures('table')
@pytest.mark.parametrize('claims', [ADMIN, OPEN_USER])
def test_admins_and_unrestricted_users_get_the_whole_design_system(api_gateway_event, lambda_context, claims):
    body = _get(api_gateway_event, lambda_context, '/settings/design-system', claims)
    assert (body['guidelines'], len(body['tokens']['colors']), len(body['components'])) == (GUIDELINES, 2, 3)
