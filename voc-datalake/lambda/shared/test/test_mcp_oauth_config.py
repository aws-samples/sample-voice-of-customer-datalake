"""OAuth deployment facts (shared/mcp_oauth_config.py) and loopback URIs (shared/mcp_oauth_loopback.py)."""
from __future__ import annotations

import json

import pytest

from shared.mcp_oauth_config import canonical_url, oauth_config, token_minting_enabled
from shared.mcp_oauth_loopback import loopback_path
from shared.test.mcp_oauth_fixtures import API, CLIENTS, RESOURCE, oauth_env


def test_a_complete_environment_loads():
    with oauth_env():
        config = oauth_config()
    assert config is not None
    assert config.resource == RESOURCE
    assert config.issuer == API
    assert config.relay_url == f'{API}/oauth/callback'
    assert config.scopes_supported == [f'{RESOURCE}/read', f'{RESOURCE}/write']
    assert config.kind_of(CLIENTS['cursor']) == 'cursor'
    assert config.kind_of('web-app-client') is None


@pytest.mark.parametrize('overrides', [
    {'MCP_RESOURCE_URL': ''},
    {'MCP_RESOURCE_URL': 'http://abc123.execute-api.us-east-1.amazonaws.com/v1/mcp/global'},
    {'MCP_RESOURCE_URL': 'https://other.example.com/v1/mcp/global'},
    {'MCP_OAUTH_CLIENTS': '{}'},
    {'MCP_OAUTH_CLIENTS': 'not json'},
    {'MCP_OAUTH_CLIENTS': json.dumps({'kiro': 'same', 'cursor': 'same'})},
    {'MCP_OAUTH_CLIENTS': json.dumps({'kiro': 'a', 'unknown-kind': 'b'})},
    {'MCP_OAUTH_WEB_CALLBACKS': '"one"'},
    {'COGNITO_ISSUER': ''},
    {'FRONTEND_URL': ''},
])
def test_anything_missing_or_malformed_turns_oauth_off(overrides):
    with oauth_env(**overrides):
        assert oauth_config() is None


def test_the_minting_switch_defaults_on(monkeypatch):
    monkeypatch.delenv('MCP_TOKEN_MINTING', raising=False)
    assert token_minting_enabled()
    monkeypatch.setenv('MCP_TOKEN_MINTING', 'false')
    assert not token_minting_enabled()


@pytest.mark.parametrize(('url', 'expected'), [
    ('HTTPS://Example.COM/a/', 'https://example.com/a'),
    ('https://example.com:443/a?x=1#f', 'https://example.com/a'),
    ('https://example.com:8443/a', 'https://example.com:8443/a'),
    ('http://example.com/a', None),
    ('https://user@example.com/a', None),
    ('', None),
    (None, None),
])
def test_canonical_url(url, expected):
    assert canonical_url(url) == expected


@pytest.mark.parametrize('uri', [
    'http://127.0.0.1:1024/callback', 'http://localhost:65535/callback', 'http://[::1]:49152/callback',
])
def test_loopback_on_any_allowed_port(uri):
    assert loopback_path(uri) == '/callback'


@pytest.mark.parametrize('uri', [
    'https://127.0.0.1:5000/callback',          # not plain http
    'http://127.0.0.1/callback',                # no port
    'http://127.0.0.1:80/callback',             # privileged port
    'http://127.0.0.1:70000/callback',          # out of range
    'http://evil.example.com:5000/callback',    # not loopback
    'http://127.0.0.1.evil.example.com:5000/callback',
    'http://user@127.0.0.1:5000/callback',      # user info
    'http://127.0.0.1:5000@evil.example.com/callback',
    'http://127.0.0.1:5000/callback?x=1',       # query
    'http://127.0.0.1:5000/callback#x',         # fragment
    'http://127.0.0.1:5000\\@evil.example.com/callback',
    'http://127.0.0.1:5000/other',              # wrong path
    'http://127.0.0.1:5000/callback/',          # wrong path
    None, 7, '',
])
def test_not_loopback_for_the_callback_path(uri):
    assert loopback_path(uri) != '/callback'


def test_loopback_path_reads_the_path():
    assert loopback_path('http://127.0.0.1:5173/oauth/callback') == '/oauth/callback'
