"""Access-token verification (shared/mcp_oauth_jwt.py): every refusal the MCP server relies on."""
from __future__ import annotations

import time

import pytest

from shared.mcp_oauth_config import oauth_config
from shared.mcp_oauth_jwt import (
    InvalidToken,
    JwksCache,
    JwksUnavailable,
    public_key_from_jwk,
    unverified_claims,
    verify_access_token,
)
from shared.test.mcp_oauth_fixtures import (
    CLIENTS,
    KID,
    RESOURCE,
    access_claims,
    jwk,
    jwks_cache,
    oauth_env,
    sign,
    signing_key,
    unsigned,
)


@pytest.fixture
def config():
    with oauth_env():
        loaded = oauth_config()
        assert loaded is not None
        yield loaded


def _verify(token, config, cache=None):
    return verify_access_token(token, config, now=time.time(), cache=cache or jwks_cache())


def test_a_valid_token_yields_its_claims(config):
    claims = _verify(sign(access_claims()), config)
    assert claims.sub == 'sub-alice'
    assert claims.username == 'alice'
    assert claims.client_id == CLIENTS['kiro']
    assert claims.origin_jti == 'chain-1'
    assert f'{RESOURCE}/write' in claims.scopes


@pytest.mark.parametrize(('overrides', 'reason'), [
    ({'iss': 'https://cognito-idp.us-east-1.amazonaws.com/other_pool'}, 'wrong issuer'),
    ({'token_use': 'id'}, 'not an access token'),
    ({'client_id': 'the-web-app-client'}, 'not an MCP client'),
    ({'exp': int(time.time()) - 1}, 'expired'),
    ({'iat': int(time.time()) + 3600}, 'issued in the future'),
    ({'aud': 'https://elsewhere.example.com/mcp'}, 'wrong audience'),
    ({'aud': [RESOURCE, 'https://elsewhere.example.com']}, 'wrong audience'),
    ({'origin_jti': None}, 'no origin_jti'),
    ({'sub': None}, 'no sub'),
    ({'username': None}, 'no username'),
    ({'exp': True}, 'no exp'),
])
def test_claims_that_fail_are_refused(config, overrides, reason):
    with pytest.raises(InvalidToken, match=reason):
        _verify(sign(access_claims(**overrides)), config)


def test_a_matching_audience_is_accepted_canonically(config):
    claims = _verify(sign(access_claims(aud='HTTPS://ABC123.execute-api.us-east-1.amazonaws.com/v1/mcp/global/')), config)
    assert claims.sub == 'sub-alice'


@pytest.mark.parametrize('alg', ['none', 'HS256', 'RS512', 'ES256'])
def test_any_algorithm_but_rs256_is_refused(config, alg):
    with pytest.raises(InvalidToken, match='unsupported algorithm'):
        _verify(unsigned(access_claims(), alg=alg), config)


def test_an_hs256_token_keyed_with_the_public_key_is_refused(config):
    header = {'alg': 'HS256', 'kid': KID}
    with pytest.raises(InvalidToken, match='unsupported algorithm'):
        _verify(sign(access_claims(), header=header), config)


def test_a_signature_by_another_key_is_refused(config):
    with pytest.raises(InvalidToken, match='bad signature'):
        _verify(sign(access_claims(), key=signing_key('attacker')), config)


def test_a_tampered_payload_is_refused(config):
    head, _payload, signature = sign(access_claims()).split('.')
    forged = sign(access_claims(sub='sub-root')).split('.')[1]
    with pytest.raises(InvalidToken, match='bad signature'):
        _verify(f'{head}.{forged}.{signature}', config)


def test_an_unknown_kid_is_refused(config):
    with pytest.raises(InvalidToken, match='unknown key id'):
        _verify(sign(access_claims(), header={'alg': 'RS256', 'kid': 'other'}), config)


@pytest.mark.parametrize('token', ['', 'abc', 'a.b', 'a.b.c.d', 'eyJ.eyJ.', 'x' * 9000])
def test_garbage_is_refused(config, token):
    with pytest.raises(InvalidToken):
        _verify(token, config)


def test_a_jwks_fault_is_unavailable_not_invalid(config):
    def broken(_url):
        raise JwksUnavailable('down')
    with pytest.raises(JwksUnavailable):
        _verify(sign(access_claims()), config, JwksCache(fetch=broken))


def test_the_jwks_is_cached_and_reread_only_for_an_unknown_kid_after_the_floor(config):
    calls: list[str] = []
    clock = [0.0]

    def fetch(url):
        calls.append(url)
        return {'keys': [jwk()]}

    cache = JwksCache(fetch=fetch, clock=lambda: clock[0])
    token = sign(access_claims())
    _verify(token, config, cache)
    _verify(token, config, cache)
    assert len(calls) == 1
    assert calls[0] == 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e/.well-known/jwks.json'
    unknown = sign(access_claims(), header={'alg': 'RS256', 'kid': 'rotated'})
    with pytest.raises(InvalidToken):
        _verify(unknown, config, cache)
    assert len(calls) == 1  # within the refresh floor
    clock[0] = 61
    with pytest.raises(InvalidToken):
        _verify(unknown, config, cache)
    assert len(calls) == 2
    clock[0] = 61 + 3600
    _verify(token, config, cache)
    assert len(calls) == 3  # TTL


@pytest.mark.parametrize('overrides', [
    {'kty': 'EC'}, {'use': 'enc'}, {'alg': 'RS512'}, {'n': 'AQAB'}, {'e': 7},
])
def test_jwks_entries_that_are_not_rs256_signing_keys_are_ignored(overrides):
    assert public_key_from_jwk({**jwk(), **overrides}) is None


def test_unverified_claims_only_decodes():
    decoded = unverified_claims(sign(access_claims()))
    assert decoded is not None
    assert decoded['sub'] == 'sub-alice'
    assert unverified_claims('not-a-jwt') is None
    assert unverified_claims(None) is None
