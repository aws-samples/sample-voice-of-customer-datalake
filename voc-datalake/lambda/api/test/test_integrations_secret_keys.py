"""GET /integrations/<source>/credentials never returns a value its manifest marks secret (BE-5).

The GitHub token and webhook HMAC secret are write-only once saved; the plugin's non-secret settings
(repositories, labels) still come back so the form can show them.
"""
import json
from unittest.mock import patch

import pytest
from handler_events_fixtures import call_route

import integrations_handler as h
from integrations_handler import lambda_handler

STORED = {
    'github_issues_token': 'ghp_real_token',
    'github_issues_webhook_secret': 'hmac-secret',
    'github_issues_repositories': 'example/app',
}


@pytest.fixture
def secret_keys_env(monkeypatch):
    """The env CDK writes for the github_issues manifest, with the parse cache cleared around the test."""
    monkeypatch.setenv(h.WRITE_ONLY_FIELDS_ENV_VAR, json.dumps({'github_issues': ['token', 'webhook_secret']}))
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


@pytest.mark.usefixtures('secret_keys_env', 'plugin_secret_defaults')
def test_secret_values_are_never_returned(api_gateway_event, lambda_context):
    response, body = _get(api_gateway_event, lambda_context, 'token,webhook_secret,repositories')
    assert response['statusCode'] == 200
    assert body == {'repositories': 'example/app'}


@pytest.mark.parametrize('raw', ['', 'not json', '["token"]'])
def test_an_absent_or_malformed_variable_reads_as_no_secret_keys(monkeypatch, raw):
    monkeypatch.setenv(h.WRITE_ONLY_FIELDS_ENV_VAR, raw)
    h._write_only_fields.cache_clear()
    try:
        assert h._write_only_fields() == {}
    finally:
        h._write_only_fields.cache_clear()
