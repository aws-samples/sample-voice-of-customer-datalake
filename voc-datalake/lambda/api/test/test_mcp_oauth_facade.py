"""The anonymous MCP OAuth facade and the consent API of voc-mcp-tokens-api, route by route."""
from __future__ import annotations

import os
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

import pytest
from global_mcp_oauth_world import CHALLENGE, anonymous, oauth_world
from moto_helpers import rest_event

import mcp_tokens_handler
from shared.test.mcp_oauth_fixtures import (
    API,
    CLIENTS,
    COGNITO_DOMAIN,
    CURSOR_WEB_CALLBACK,
    FRONTEND,
    RESOURCE,
    WEB_CALLBACK,
)


@pytest.fixture
def oauth(lambda_context):
    with oauth_world(lambda_context) as built:
        yield built


def _no_store(reply):
    assert reply.headers['Cache-Control'] in {'no-store', 'private, no-store'}


def _grant_rows(oauth) -> list[dict]:
    return [item for item in oauth.world.projects.scan()['Items'] if item.get('kind') == 'oauth_grant']


class TestDiscovery:
    @pytest.mark.parametrize('path', ['/.well-known/oauth-protected-resource',
                                      '/.well-known/oauth-protected-resource/mcp/global'])
    def test_protected_resource_metadata(self, oauth, path):
        reply = oauth.call(anonymous('GET', path))
        assert reply.status == 200
        assert reply.body == {'resource': RESOURCE, 'authorization_servers': [API],
                              'scopes_supported': [f'{RESOURCE}/read', f'{RESOURCE}/write'],
                              'bearer_methods_supported': ['header'], 'resource_name': 'VoC Data Lake'}
        _no_store(reply)

    @pytest.mark.parametrize('path', ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'])
    def test_authorization_server_metadata(self, oauth, path):
        body = oauth.call(anonymous('GET', path)).body
        assert body['issuer'] == API
        assert body['code_challenge_methods_supported'] == ['S256']
        assert body['authorization_endpoint'] == f'{API}/oauth/authorize'
        assert body['token_endpoint'] == f'{API}/oauth/token'
        assert body['registration_endpoint'] == f'{API}/oauth/register'
        assert body['revocation_endpoint'] == f'{API}/oauth/revoke'
        assert body['jwks_uri'] == 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e/.well-known/jwks.json'
        assert body['token_endpoint_auth_methods_supported'] == ['none']
        assert body['grant_types_supported'] == ['authorization_code', 'refresh_token']

    def test_every_route_is_404_when_oauth_is_off(self, oauth):
        with patch.dict(os.environ, {'MCP_OAUTH_CLIENTS': ''}):
            for method, path in [('GET', '/.well-known/oauth-protected-resource'), ('POST', '/oauth/register'),
                                 ('GET', '/oauth/authorize'), ('GET', '/oauth/callback'), ('POST', '/oauth/token'),
                                 ('POST', '/oauth/revoke')]:
                assert oauth.call(anonymous(method, path, json_body={})).status == 404, path


class TestRegistration:
    @pytest.mark.parametrize(('uris', 'name', 'kind'), [
        (['http://127.0.0.1:53111/oauth/callback'], 'Kiro CLI', 'kiro'),
        (['http://localhost:61000/callback'], 'Claude Code (voc)', 'claude-code'),
        (['http://127.0.0.1:8787/callback'], 'Cursor', 'cursor'),
        (['http://127.0.0.1:8787/callback', CURSOR_WEB_CALLBACK], 'Cursor', 'cursor'),
        ([CURSOR_WEB_CALLBACK], 'anything', 'cursor'),
        ([WEB_CALLBACK], 'Web assistant', 'web'),
    ])
    def test_answers_the_preregistered_client(self, oauth, uris, name, kind):
        reply = oauth.call(anonymous('POST', '/oauth/register', json_body={'redirect_uris': uris, 'client_name': name}))
        assert reply.status == 201, reply.body
        assert reply.body['client_id'] == CLIENTS[kind]
        assert reply.body['token_endpoint_auth_method'] == 'none'
        assert reply.body['client_id_issued_at'] == 0
        assert 'client_secret' not in reply.body
        assert reply.body['redirect_uris'] == uris

    def test_unknown_web_uris_are_dropped_not_refused(self, oauth):
        uris = ['http://127.0.0.1:8787/callback', 'https://elsewhere.example.com/cb']
        reply = oauth.call(anonymous('POST', '/oauth/register', json_body={'redirect_uris': uris, 'client_name': 'Cursor'}))
        assert reply.status == 201
        assert reply.body['redirect_uris'] == ['http://127.0.0.1:8787/callback']

    @pytest.mark.parametrize(('body', 'error'), [
        ({'redirect_uris': ['https://elsewhere.example.com/cb']}, 'invalid_redirect_uri'),
        ({'redirect_uris': ['http://127.0.0.1:5000/other']}, 'invalid_redirect_uri'),
        ({'redirect_uris': ['http://127.0.0.1:5000/callback', 'http://127.0.0.1:5000/oauth/callback']},
         'invalid_redirect_uri'),
        ({'redirect_uris': []}, 'invalid_redirect_uri'),
        ({'redirect_uris': 'http://127.0.0.1:5000/callback'}, 'invalid_redirect_uri'),
        ({'redirect_uris': ['http://127.0.0.1:5000/callback'], 'token_endpoint_auth_method': 'client_secret_basic'},
         'invalid_client_metadata'),
        ({'redirect_uris': ['http://127.0.0.1:5000/callback'], 'grant_types': ['client_credentials']},
         'invalid_client_metadata'),
        ({'redirect_uris': ['http://127.0.0.1:5000/callback'], 'response_types': ['token']}, 'invalid_client_metadata'),
    ])
    def test_refusals(self, oauth, body, error):
        reply = oauth.call(anonymous('POST', '/oauth/register', json_body=body))
        assert reply.status == 400
        assert reply.body['error'] == error

    def test_a_body_over_8_kb_is_refused(self, oauth):
        body = {'redirect_uris': ['http://127.0.0.1:5000/callback'], 'client_name': 'x' * 9000}
        assert oauth.call(anonymous('POST', '/oauth/register', json_body=body)).status == 400


class TestAuthorize:
    def test_redirects_to_the_consent_page_with_the_query_unchanged(self, oauth):
        query = oauth.authorize_query(CLIENTS['kiro'], 'http://127.0.0.1:5000/oauth/callback')
        reply = oauth.call(anonymous('GET', '/oauth/authorize', query=query))
        assert reply.status == 302
        location = urlsplit(reply.headers['Location'])
        assert f'{location.scheme}://{location.netloc}{location.path}' == f'{FRONTEND}/oauth/authorize'
        assert {k: v[0] for k, v in parse_qs(location.query).items()} == query

    @pytest.mark.parametrize(('client_id', 'redirect_uri'), [
        ('the-web-app-client', 'http://127.0.0.1:5000/oauth/callback'),
        (CLIENTS['kiro'], 'http://127.0.0.1:5000/callback'),
        (CLIENTS['kiro'], 'https://evil.example.com/oauth/callback'),
        (CLIENTS['web'], 'https://evil.example.com/cb'),
    ])
    def test_an_untrusted_client_or_redirect_is_never_redirected(self, oauth, client_id, redirect_uri):
        reply = oauth.call(anonymous('GET', '/oauth/authorize', query=oauth.authorize_query(client_id, redirect_uri)))
        assert reply.status == 400
        assert 'Location' not in reply.headers

    @pytest.mark.parametrize(('change', 'error'), [
        ({'code_challenge_method': 'plain'}, 'invalid_request'),
        ({'code_challenge': 'short'}, 'invalid_request'),
        ({'response_type': 'token'}, 'unsupported_response_type'),
        ({'scope': 'openid admin'}, 'invalid_scope'),
        ({'resource': 'https://elsewhere.example.com/mcp'}, 'invalid_target'),
    ])
    def test_other_faults_go_back_to_the_client(self, oauth, change, error):
        redirect_uri = 'http://127.0.0.1:5000/oauth/callback'
        query = {**oauth.authorize_query(CLIENTS['kiro'], redirect_uri), **change}
        reply = oauth.call(anonymous('GET', '/oauth/authorize', query=query))
        assert reply.status == 302
        assert reply.headers['Location'].startswith(f'{redirect_uri}?')
        back = parse_qs(urlsplit(reply.headers['Location']).query)
        assert back['error'] == [error]
        assert back['state'] == ['client-state']


class TestConsent:
    def _query(self, oauth, **extra):
        return oauth.authorize_query(CLIENTS['kiro'], 'http://127.0.0.1:5000/oauth/callback', **extra)

    def test_describe_names_the_client_and_never_writes(self, oauth):
        status, body = oauth.consent_api('alice', 'GET', '/connect/oauth/consent',
                                         query={'authorize_query': urlencode(self._query(oauth))})
        assert status == 200
        assert body['client_name'] == 'Kiro'
        assert body['can_write'] is True
        assert body['deny_redirect'].startswith('http://127.0.0.1:5000/oauth/callback?error=access_denied')
        assert _grant_rows(oauth) == []

    def test_approval_redirects_to_cognito_through_the_relay(self, oauth):
        status, body = oauth.consent('alice', self._query(oauth, resource=RESOURCE), scope='read')
        assert status == 200
        url = urlsplit(body['redirect_to'])
        assert f'{url.scheme}://{url.netloc}{url.path}' == f'{COGNITO_DOMAIN}/oauth2/authorize'
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        assert params['redirect_uri'] == f'{API}/oauth/callback'
        assert params['state'] != 'client-state'
        assert params['scope'] == f'openid {RESOURCE}/read'
        assert params['code_challenge'] == CHALLENGE
        assert 'resource' not in params  # dropped unless -c mcpOAuthResourceIndicator=true

    def test_write_is_refused_when_the_client_asked_for_read(self, oauth):
        status, _ = oauth.consent('alice', self._query(oauth, scope=f'openid {RESOURCE}/read'), scope='write')
        assert status == 400

    def test_a_pin_the_person_cannot_view_is_refused(self, oauth):
        status, _ = oauth.consent('alice', self._query(oauth), project_id='proj_beta')
        assert status == 404

    def test_a_delegated_credential_cannot_consent(self, oauth):
        claims = {'sub': 'mcp:tok_x', 'voc:acting_subject': oauth.world.subs['alice']}
        event = rest_event('POST', '/connect/oauth/consent', claims=claims,
                           body={'authorize_query': urlencode(self._query(oauth)), 'scope': 'read'})
        assert mcp_tokens_handler.lambda_handler(event, oauth.world.context)['statusCode'] == 403
        assert _grant_rows(oauth) == []

    def test_my_grants_lists_only_mine(self, oauth):
        oauth.consent('alice', self._query(oauth))
        _, mine = oauth.consent_api('alice', 'GET', '/connect/oauth/grants')
        _, theirs = oauth.consent_api('bob', 'GET', '/connect/oauth/grants')
        assert [g['client_name'] for g in mine['grants']] == ['Kiro']
        assert mine['grants'][0]['signed_in'] is False
        assert theirs['grants'] == []


class TestRelayAndToken:
    def test_the_relay_is_single_use(self, oauth):
        _, approved = oauth.consent('alice', oauth.authorize_query(CLIENTS['kiro'], 'http://127.0.0.1:5000/oauth/callback'))
        delivered = oauth.cognito.sign_in(approved['redirect_to'], 'alice')
        assert oauth.call(anonymous('GET', '/oauth/callback', query=delivered)).status == 302
        assert oauth.call(anonymous('GET', '/oauth/callback', query=delivered)).status == 400

    @pytest.mark.parametrize('query', [{}, {'state': 'x', 'code': 'y'}, {'state': 'a' * 43, 'code': 'y'}])
    def test_an_unknown_relay_is_refused_without_a_redirect(self, oauth, query):
        reply = oauth.call(anonymous('GET', '/oauth/callback', query=query))
        assert reply.status == 400
        assert 'Location' not in reply.headers

    def test_a_cognito_error_is_relayed_to_the_client(self, oauth):
        _, approved = oauth.consent('alice', oauth.authorize_query(CLIENTS['kiro'], 'http://127.0.0.1:5000/oauth/callback'))
        state = parse_qs(urlsplit(approved['redirect_to']).query)['state'][0]
        reply = oauth.call(anonymous('GET', '/oauth/callback', query={'state': state, 'error': 'access_denied'}))
        assert reply.headers['Location'] == 'http://127.0.0.1:5000/oauth/callback?error=access_denied&state=client-state'

    def test_a_code_is_bound_to_its_client_and_loopback_uri(self, oauth):
        redirect_uri = 'http://127.0.0.1:5000/oauth/callback'
        _, approved = oauth.consent('alice', oauth.authorize_query(CLIENTS['kiro'], redirect_uri))
        delivered = oauth.cognito.sign_in(approved['redirect_to'], 'alice')
        location = oauth.call(anonymous('GET', '/oauth/callback', query=delivered)).headers['Location']
        code = parse_qs(urlsplit(location).query)['code'][0]
        wrong = oauth.exchange({'grant_type': 'authorization_code', 'client_id': CLIENTS['kiro'], 'code': code,
                                'redirect_uri': 'http://127.0.0.1:5999/oauth/callback', 'code_verifier': 'v' * 43})
        assert wrong.body['error'] == 'invalid_grant'
        replay = oauth.exchange({'grant_type': 'authorization_code', 'client_id': CLIENTS['kiro'], 'code': code,
                                 'redirect_uri': redirect_uri, 'code_verifier': 'v' * 43})
        assert replay.body['error'] == 'invalid_grant'  # the binding was consumed by the first attempt

    @pytest.mark.parametrize(('form', 'status', 'error'), [
        ({'grant_type': 'client_credentials', 'client_id': CLIENTS['kiro']}, 400, 'unsupported_grant_type'),
        ({'grant_type': 'authorization_code', 'client_id': 'the-web-app-client'}, 401, 'invalid_client'),
        ({'grant_type': 'authorization_code', 'client_id': CLIENTS['kiro']}, 400, 'invalid_request'),
        ({'grant_type': 'refresh_token', 'client_id': CLIENTS['kiro']}, 400, 'invalid_request'),
    ])
    def test_token_refusals(self, oauth, form, status, error):
        reply = oauth.exchange(form)
        assert (reply.status, reply.body['error']) == (status, error)
        _no_store(reply)

    def test_a_json_body_is_not_a_form(self, oauth):
        reply = oauth.call(anonymous('POST', '/oauth/token', json_body={'grant_type': 'refresh_token'}))
        assert reply.body['error'] == 'invalid_request'

    def test_revoke_forwards_to_cognito(self, oauth):
        reply = oauth.call(anonymous('POST', '/oauth/revoke', form={'token': 'rt', 'client_id': CLIENTS['kiro']}))
        assert reply.status == 200
        assert oauth.cognito.revoked == ['rt']


class TestMintingSwitch:
    def test_off_refuses_minting_but_keeps_existing_tokens(self, oauth):
        minted = oauth.world.mint('alice', scope='read')
        with patch.dict(os.environ, {'MCP_TOKEN_MINTING': 'false'}):
            status, body = oauth.world.tokens_api('alice', 'POST', '/connect/tokens', {'name': 'x', 'scope': 'read'})
            assert status == 403
            _, listed = oauth.world.tokens_api('alice', 'GET', '/connect/tokens')
            assert listed['minting_enabled'] is False
            assert oauth.world.client(minted).connect().status == 200
        _, listed = oauth.world.tokens_api('alice', 'GET', '/connect/tokens')
        assert listed['minting_enabled'] is True
        assert listed['oauth']['enabled'] is True
        assert [c['kind'] for c in listed['oauth']['clients']] == list(CLIENTS)
        assert 'error' in body
