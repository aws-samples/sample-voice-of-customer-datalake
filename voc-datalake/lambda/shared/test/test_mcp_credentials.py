"""The OAuth credential check of /mcp/global (shared/mcp_credentials.py) and the grant rules it applies."""
from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime, timedelta

import pytest

from shared import mcp_global_tokens as gt
from shared import mcp_oauth_grants as grants
from shared.mcp_credentials import CredentialBackendUnavailable, authenticate_oauth, looks_like_jwt
from shared.mcp_oauth_jwt import JwksCache, JwksUnavailable
from shared.test.mcp_oauth_fixtures import CLIENTS, RESOURCE, access_claims, jwks_cache, oauth_env, sign

NOW = datetime.now(UTC)


def _grant(**overrides):
    row = grants.grant_item(subject='sub-alice', username='alice', is_admin=False, client_id=CLIENTS['kiro'],
                            client_kind='kiro', scope='write', project_id=None, code_challenge='c' * 43, now=NOW)
    row['origin_jtis'] = ['chain-1']
    row.update(overrides)
    return row


def _check(token, row, *, minter_current=True, cache=None):
    loaded: list[str] = []

    def load(token_id):
        loaded.append(token_id)
        return row

    # Checked at the moment of the call: the token was signed just now (access_claims reads the clock), and
    # NOW is fixed at import, possibly minutes earlier under a loaded parallel run (past the iat leeway).
    with oauth_env():
        result = authenticate_oauth(token, load_row=load, minter_current=lambda _r: minter_current,
                                    now=datetime.now(UTC),
                                    cache=cache or jwks_cache())
    return result, loaded


def test_a_signed_in_user_gets_their_grant_as_the_credential_row():
    row, loaded = _check(sign(access_claims()), _grant())
    assert loaded == [grants.grant_id('sub-alice', CLIENTS['kiro'])]
    assert row is not None
    assert row['token_id'].startswith('oag_')
    assert row['scope'] == 'write'
    assert row['created_by'] == 'sub-alice'
    assert row['minted_by_admin'] is False


def test_a_read_only_token_narrows_a_write_grant():
    row, _ = _check(sign(access_claims(scope=f'openid {RESOURCE}/read')), _grant())
    assert row is not None
    assert row['scope'] == 'read'


def test_a_write_token_cannot_widen_a_read_grant():
    row, _ = _check(sign(access_claims()), _grant(scope='read'))
    assert row is not None
    assert row['scope'] == 'read'


def test_a_token_without_an_mcp_scope_is_refused():
    assert _check(sign(access_claims(scope='openid')), _grant())[0] is None


@pytest.mark.parametrize('overrides', [
    {'revoked_at': NOW.isoformat()},
    {'expires_at': (NOW - timedelta(seconds=1)).isoformat()},
    {'origin_jtis': ['another-chain']},
    {'origin_jtis': []},
    {'created_by': 'sub-mallory'},
    {'client_id': CLIENTS['cursor']},
    {'kind': 'token'},
    {'secret_hash': 'x'},
])
def test_an_unusable_grant_refuses(overrides):
    assert _check(sign(access_claims()), _grant(**overrides))[0] is None


def test_no_grant_refuses():
    assert _check(sign(access_claims()), None)[0] is None


def test_a_user_no_longer_current_is_refused():
    assert _check(sign(access_claims()), _grant(), minter_current=False)[0] is None


def test_a_token_for_another_username_is_refused():
    assert _check(sign(access_claims(username='mallory')), _grant())[0] is None


def test_an_invalid_jwt_never_reads_the_store():
    row, loaded = _check(sign(access_claims(client_id='web-app')), _grant())
    assert row is None
    assert loaded == []


def test_a_jwks_fault_is_a_backend_fault():
    def broken(_url):
        raise JwksUnavailable('down')
    with pytest.raises(CredentialBackendUnavailable):
        _check(sign(access_claims()), _grant(), cache=JwksCache(fetch=broken))


def test_oauth_off_refuses_every_jwt():
    with oauth_env(MCP_OAUTH_CLIENTS=''):
        assert authenticate_oauth(sign(access_claims()), load_row=lambda _t: _grant(),
                                  minter_current=lambda _r: True, now=datetime.now(UTC), cache=jwks_cache()) is None


def test_only_compact_jws_shapes_are_routed_to_oauth():
    assert looks_like_jwt(sign(access_claims()))
    assert not looks_like_jwt('voc_tok_0123456789abcdef_' + 'a' * 64)
    assert not looks_like_jwt('eyJ.only-two')


def test_grant_ids_are_per_person_and_client():
    a = grants.grant_id('sub-alice', 'kiro-client')
    assert a == grants.grant_id('sub-alice', 'kiro-client')
    assert a != grants.grant_id('sub-bob', 'kiro-client')
    assert a != grants.grant_id('sub-alice', 'cursor-client')
    assert gt.is_path_id(a)


def test_chains_keep_the_newest_few():
    row = _grant(origin_jtis=[f'c{i}' for i in range(grants.MAX_CHAINS)])
    assert grants.with_chain(row, 'new') == [*[f'c{i}' for i in range(1, grants.MAX_CHAINS)], 'new']
    assert grants.with_chain(row, 'c0')[-1] == 'c0'


def test_the_chain_window_closes():
    row = _grant()
    assert grants.chain_window_open(row, NOW)
    assert not grants.chain_window_open(row, NOW + timedelta(minutes=grants.CHAIN_WINDOW_MINUTES))


def test_grant_view_never_shows_chains_or_subject():
    view = grants.grant_view(_grant(), NOW)
    assert 'origin_jtis' not in view
    assert 'created_by' not in view
    assert view['client_name'] == 'Kiro'
    assert view['signed_in'] is True


RFC_VERIFIER = 'Example-Air-verifier_0123456789.abcdefghijk~'
# BASE64URL(SHA256(verifier)) without padding (RFC 7636 §4.2), computed outside the code under test.
RFC_CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(RFC_VERIFIER.encode()).digest()).rstrip(b'=').decode()


def test_s256_is_rfc_7636():
    assert grants.s256_challenge(RFC_VERIFIER) == RFC_CHALLENGE
    assert '=' not in RFC_CHALLENGE
    assert len(RFC_CHALLENGE) == 43


def test_the_consent_window_is_bound_to_the_consented_challenge():
    row = grants.grant_item(subject='s', username='u', is_admin=False, client_id=CLIENTS['kiro'], client_kind='kiro',
                            scope='read', project_id=None, code_challenge=RFC_CHALLENGE, now=NOW)
    assert RFC_CHALLENGE not in str(row)  # only its hash is stored
    assert grants.verifier_matches_consent(row, RFC_VERIFIER)
    assert not grants.verifier_matches_consent(row, 'x' * 43)
    assert not grants.verifier_matches_consent(row, None)
    assert not grants.verifier_matches_consent(row, '')
    legacy = {key: value for key, value in row.items() if key != 'consent_challenge_sha256'}
    assert not grants.verifier_matches_consent(legacy, RFC_VERIFIER)
