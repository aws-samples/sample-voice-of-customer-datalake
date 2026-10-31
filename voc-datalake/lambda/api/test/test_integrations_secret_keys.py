"""GET /integrations/<source>/credentials never returns a value its manifest marks secret (BE-5).

The GitHub token and webhook HMAC secret are write-only once saved; the plugin's non-secret settings
(repositories, labels) still come back so the form can show them. PLUGIN_SECRET_KEYS is the conftest's
autouse value, derived from the same manifests CDK reads.
"""
import json
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route
from plugin_manifests import PLUGIN_SECRET_KEYS

import integrations_handler as h
from integrations_handler import lambda_handler

STORED = {
    'github_issues_token': 'ghp_real_token',
    'github_issues_webhook_secret': 'hmac-secret',
    'github_issues_repos': 'example/app',
}


@pytest.fixture(autouse=True)
def _fresh_parse():
    h._write_only_fields.cache_clear()
    yield
    h._write_only_fields.cache_clear()


def _get(api_gateway_event, lambda_context, keys: str):
    with patch('integrations_handler.secretsmanager') as secrets:
        secrets.get_secret_value.return_value = {'SecretString': json.dumps(STORED)}
        return call_route(
            lambda_handler, api_gateway_event, lambda_context,
            method='GET', path='/integrations/github_issues/credentials',
            path_params={'source': 'github_issues'}, query_params={'keys': keys},
        )


def test_the_github_manifest_marks_its_token_and_webhook_secret():
    assert sorted(PLUGIN_SECRET_KEYS['github_issues']) == ['token', 'webhook_secret']


@pytest.mark.usefixtures('plugin_secret_defaults')
def test_secret_values_are_never_returned(api_gateway_event, lambda_context):
    response, body = _get(api_gateway_event, lambda_context, 'token,webhook_secret,repos')
    assert response['statusCode'] == 200
    assert body == {'repos': 'example/app'}


@pytest.mark.parametrize('raw', ['', 'not json', '["token"]'])
def test_an_absent_or_malformed_variable_is_unreadable(monkeypatch, raw):
    monkeypatch.setenv(h.WRITE_ONLY_FIELDS_ENV_VAR, raw)
    assert h._write_only_fields() is None


@pytest.mark.usefixtures('plugin_secret_defaults')
def test_an_unreadable_variable_fails_closed_returning_no_value(monkeypatch, api_gateway_event, lambda_context):
    monkeypatch.delenv(h.WRITE_ONLY_FIELDS_ENV_VAR)
    response, body = _get(api_gateway_event, lambda_context, 'token,repos')
    assert response['statusCode'] == 200
    assert body == {}
