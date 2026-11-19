"""voc-engineering-user-auth and the broker's reader of the owners' tokens (user_auth.py, 7.57.00): one action, refused
before anything is read otherwise; the code exchanged with the App's client, the token kept in SSM under the person's
key and never answered or logged; a refresh when due, written back, and a lost race read again; no token, no pass."""
from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs

import boto3
import pytest
from moto import mock_aws

from engineering.connectors.hosts import OwnerUnauthorized
from engineering.connectors.transport import Response
from engineering.connectors.user_auth import (
    AuthorizationRefused,
    ClientUnavailable,
    GitHubOAuth,
    OwnerTokens,
    UserAuth,
    UserAuthRefused,
    parse_exchange,
)
from engineering.connectors.user_auth_paths import client_parameter, client_value, subject_hash, user_parameter

PREFIX = '/voc/engineering-user-auth/'
APP_ID = '4242'
OWNER = subject_hash('person-sub-1')
CLIENT_ID = 'Iv23liExample0Client1'
CLIENT_SECRET = '0123456789abcdef0123456789abcdef01234567'
ACCESS = 'ghu_accessTokenForTests000000000001'
REFRESH = 'ghr_refreshTokenForTests00000000001'
NOW = 1_800_000_000.0
REDIRECT = 'https://voc.example.com/agents/connections/github/authorized'


def answer(status: int = 200, data: object = None) -> Response:
    return Response(status=status, headers={}, body=json.dumps(data).encode())


@dataclass
class FakeHost:
    """github.com's token endpoint or api.github.com's user read: one answer per call, in order."""

    answers: list[Response] = field(default_factory=list)
    sent: list[tuple[str, str, dict[str, str], bytes | None]] = field(default_factory=list)

    def request(self, method: str, path: str, headers: Any, body: bytes | None) -> Response:
        self.sent.append((method, path, dict(headers), body))
        return self.answers.pop(0)


def tokens_answer(access: str = ACCESS, refresh: str = REFRESH) -> Response:
    return answer(200, {'access_token': access, 'expires_in': 28800, 'refresh_token': refresh,
                        'refresh_token_expires_in': 15897600, 'token_type': 'bearer', 'scope': ''})


class _Ssm:
    """moto's SSM client and the KMS key its parameters are put under."""

    def __init__(self, client: Any, key: str) -> None:
        self.client, self.key = client, key
        self.exceptions = client.exceptions

    def __getattr__(self, name: str) -> Any:
        return getattr(self.client, name)


@pytest.fixture
def ssm() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client('ssm', region_name='us-east-1')
        key = boto3.client('kms', region_name='us-east-1').create_key()['KeyMetadata']['Arn']
        client.put_parameter(Name=client_parameter(PREFIX, APP_ID), Type='SecureString', KeyId=key,
                             Value=client_value(APP_ID, CLIENT_ID, CLIENT_SECRET))
        yield _Ssm(client, key)


def request(**change: object) -> dict[str, object]:
    return {'action': 'exchange', 'app_id': APP_ID, 'subject_hash': OWNER, 'code': 'abc123', 'redirect_uri': REDIRECT,
            **change}


@pytest.mark.parametrize('event', [
    {'action': 'refresh'}, {}, [], request(action='open_pull_request'), request(subject_hash='person-sub-1'),
    request(redirect_uri='http://voc.example.com/agents/connections/github/authorized'),
    request(redirect_uri='https://elsewhere.example.com/callback'), request(app_id='0'), request(code='a b'),
    {**request(), 'token': 'x'},
])
def test_anything_but_an_exchange_is_refused_before_anything_is_read(event: object) -> None:
    with pytest.raises(UserAuthRefused):
        parse_exchange(event)


def test_the_code_is_exchanged_and_the_token_kept_under_the_persons_key_never_answered(
        ssm: Any, caplog: pytest.LogCaptureFixture) -> None:
    oauth, api = FakeHost([tokens_answer()]), FakeHost([answer(200, {'id': 99, 'login': 'casey-dev'})])
    auth = UserAuth(PREFIX, ssm.key, client=lambda: ssm, oauth=GitHubOAuth(oauth, api, clock=lambda: NOW))
    with caplog.at_level(logging.INFO):
        found = auth.exchange(APP_ID, OWNER, 'abc123', REDIRECT)
    assert found == {'login': 'casey-dev', 'user_id': 99, 'expires_at': '2027-01-15T16:00:00+00:00',
                     'refresh_token_expires_at': '2027-07-18T08:00:00+00:00'}
    [(method, path, headers, body)] = oauth.sent
    assert (method, path) == ('POST', '/login/oauth/access_token')
    assert parse_qs((body or b'').decode()) == {'client_id': [CLIENT_ID], 'client_secret': [CLIENT_SECRET],
                                               'code': ['abc123'], 'redirect_uri': [REDIRECT]}
    assert api.sent[0][2]['Authorization'] == f'Bearer {ACCESS}'
    stored = json.loads(ssm.get_parameter(Name=user_parameter(PREFIX, APP_ID, OWNER),
                                          WithDecryption=True)['Parameter']['Value'])
    assert (stored['access_token'], stored['refresh_token'], stored['login']) == (ACCESS, REFRESH, 'casey-dev')
    for secret in (ACCESS, REFRESH, CLIENT_SECRET, 'abc123'):
        assert secret not in json.dumps(found)
        assert secret not in caplog.text
    assert headers['Accept'] == 'application/json'


def test_a_code_github_refuses_or_an_app_without_its_client_is_refused(ssm: Any) -> None:
    oauth = FakeHost([answer(200, {'error': 'bad_verification_code', 'error_description': 'expired'})])
    auth = UserAuth(PREFIX, ssm.key, client=lambda: ssm, oauth=GitHubOAuth(oauth, FakeHost(), clock=lambda: NOW))
    with pytest.raises(AuthorizationRefused):
        auth.exchange(APP_ID, OWNER, 'abc123', REDIRECT)
    with pytest.raises(ClientUnavailable):
        auth.exchange('5555', OWNER, 'abc123', REDIRECT)
    with pytest.raises(ssm.exceptions.ParameterNotFound):
        ssm.get_parameter(Name=user_parameter(PREFIX, APP_ID, OWNER))


def _stored(ssm: Any, expires_at: str, refresh_expires_at: str = '2027-07-18T08:00:00+00:00') -> None:
    ssm.put_parameter(Name=user_parameter(PREFIX, APP_ID, OWNER), Type='SecureString', KeyId=ssm.key, Overwrite=True,
                      Value=json.dumps({'app_id': APP_ID, 'user_id': 99, 'login': 'casey-dev', 'access_token': ACCESS,
                                        'expires_at': expires_at, 'refresh_token': REFRESH,
                                        'refresh_token_expires_at': refresh_expires_at}))


def owners(ssm: Any, oauth: FakeHost, now: float = NOW) -> OwnerTokens:
    return OwnerTokens(PREFIX, ssm.key, client=lambda: ssm, oauth=GitHubOAuth(oauth, FakeHost(), clock=lambda: now),
                       clock=lambda: now)


def test_a_fresh_token_is_used_as_it_is(ssm: Any) -> None:
    _stored(ssm, '2027-01-15T16:00:00+00:00')
    oauth = FakeHost()
    token = owners(ssm, oauth).token(APP_ID, OWNER)
    assert (token.token, token.login) == (ACCESS, 'casey-dev')
    assert oauth.sent == []
    assert ACCESS not in repr(token)


def test_a_token_due_is_refreshed_and_written_back_rotated(ssm: Any) -> None:
    _stored(ssm, '2027-01-15T08:00:00+00:00')
    oauth = FakeHost([tokens_answer('ghu_rotatedAccessToken000000000002', 'ghr_rotatedRefreshToken00000000002')])
    later = 1_800_000_000.0 + 86_400 * 60   # (after the access token's expiry)
    token = owners(ssm, oauth, later).token(APP_ID, OWNER)
    assert token.token == 'ghu_rotatedAccessToken000000000002'
    assert parse_qs((oauth.sent[0][3] or b'').decode())['grant_type'] == ['refresh_token']
    stored = json.loads(ssm.get_parameter(Name=user_parameter(PREFIX, APP_ID, OWNER),
                                          WithDecryption=True)['Parameter']['Value'])
    assert stored['refresh_token'] == 'ghr_rotatedRefreshToken00000000002'


def test_no_token_an_expired_refresh_or_a_refused_one_is_no_pass(ssm: Any) -> None:
    with pytest.raises(OwnerUnauthorized):
        owners(ssm, FakeHost()).token(APP_ID, OWNER)   # (none stored)
    _stored(ssm, '2026-01-01T00:00:00+00:00', refresh_expires_at='2026-02-01T00:00:00+00:00')
    with pytest.raises(OwnerUnauthorized):
        owners(ssm, FakeHost()).token(APP_ID, OWNER)   # (both expired: nothing asked of GitHub)
    _stored(ssm, '2026-01-01T00:00:00+00:00')
    with pytest.raises(OwnerUnauthorized):
        owners(ssm, FakeHost([answer(200, {'error': 'bad_refresh_token'})])).token(APP_ID, OWNER)
    with pytest.raises(OwnerUnauthorized):
        owners(ssm, FakeHost()).token(APP_ID, 'not-a-hash')
