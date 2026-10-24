"""Every settings save that changes what cached reads return bumps config_version (docs/caching.md)."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from moto import mock_aws
from moto_helpers import pk_sk_table

from shared.data_version import CONFIG_VERSION_KEY

ADMIN = {'sub': 'sub-admin', 'cognito:groups': 'admins', 'cognito:username': 'ada'}
USER = {'sub': 'sub-user', 'cognito:groups': 'users', 'cognito:username': 'ana'}


@pytest.fixture
def aggregates():
    with mock_aws():
        table = pk_sk_table('aggregates')
        with patch('settings_handler.aggregates_table', table):
            yield table


def _put(api_gateway_event, lambda_context, path: str, body: dict, claims: dict = ADMIN) -> int:
    from settings_handler import lambda_handler
    response = lambda_handler(api_gateway_event(method='PUT', path=path, body=body, claims=claims), lambda_context)
    return response['statusCode']


def _config_version(table) -> int:
    return int((table.get_item(Key=CONFIG_VERSION_KEY).get('Item') or {}).get('v', 0))


@pytest.mark.parametrize(('path', 'body'), [
    ('/settings/brand', {'brand_name': 'Acme'}),
    ('/settings/categories', {'categories': [{'name': 'delivery', 'description': 'Parcels'}]}),
    ('/settings/dimensions', {'dimensions': []}),
    ('/settings/sources', {'sources': []}),
    ('/settings/model', {'model_id': None}),
])
def test_an_admin_save_bumps_once(aggregates, api_gateway_event, lambda_context, path, body):
    assert _put(api_gateway_event, lambda_context, path, body) == 200
    assert _config_version(aggregates) == 1


def test_a_refused_save_bumps_nothing(aggregates, api_gateway_event, lambda_context):
    assert _put(api_gateway_event, lambda_context, '/settings/categories', {'categories': []}, claims=USER) == 403
    assert _config_version(aggregates) == 0
