"""The deployment's GitHub Apps' user authorization (7.57.00; docs/autonomous-engineering.md, "Any public repository":
the upstream pull request).

A fork connection's runs end with a pull request on the fork's upstream, always one click away (the run's link to
GitHub's compare page); this authorization is the optional extra that lets the app open it as the connection's owner:
GitHub's "user access token" of the same App (its OAuth user-to-server token), because no installation token can open a
pull request on a repository the App is not installed on (and GitHub may refuse the user token there too: the run then
keeps the link). Two parts, under the user-auth parameters'
path (``ENGINEERING_USER_AUTH_PREFIX``, ``/[<prefix>-]voc/engineering-user-auth/``), deliberately outside the
connections' path, so the broker's and the checkout cache writer's read of the connections never reaches them:

* ``app/<app_id>/client``: the App's OAuth client, ``{app_id, client_id, client_secret}``, written by the Agents API (the
  App manifest's conversion, or an administrator's paste for an App made before 7.57.00), read here and by the broker;
* ``user/<app_id>/<sha256 of the subject>``: one person's token, ``{app_id, user_id, login, access_token, expires_at,
  refresh_token, refresh_token_expires_at}``, written here (the code's exchange) and by the broker (a refresh, which
  rotates both tokens), read by the broker alone, deleted by the Agents API ("Remove my authorization").

**voc-engineering-user-auth** (``lambda_handler``) takes one action from the Agents API, ``exchange {app_id,
subject_hash, code, redirect_uri}``, and refuses any other before anything is read: it reads the App's client, posts the
code to ``https://github.com/login/oauth/access_token``, reads who the token is (``GET https://api.github.com/user``,
the one use of the token here), writes the person's parameter and answers ``{login, user_id, expires_at,
refresh_token_expires_at}``: never a token. A code GitHub refuses (``bad_verification_code``, expired or used) is
``AuthorizationRefused``; a client not stored here ``ClientUnavailable``.

**The broker's reader** (``OwnerTokens``): the person's token for the one operation that uses it (``upstream_pr.py``),
refreshed when it expires within ``REFRESH_MARGIN_SECONDS`` (GitHub's user tokens live eight hours, their refresh
tokens six months); a refresh that GitHub refuses because another container refreshed first reads the parameter once
more. A token that cannot be had is ``OwnerUnauthorized``: the run ends with the fork's pull request, saying so.

No token, code or secret is ever logged, answered to the Agents API or the browser, or put in an error.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, Final
from urllib.parse import urlencode

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from engineering.connectors.connections import APP_NUMBER, PARAMETER_KEY_ENV
from engineering.connectors.hosts import HostBusy, HostError, OwnerToken, OwnerUnauthorized
from engineering.connectors.transport import HttpsTransport, Response, Transport, dig
from engineering.connectors.user_auth_paths import (
    AUTHORIZED_PATH,
    CLIENT_ID,
    CLIENT_SECRET,
    GITHUB_LOGIN,
    OAUTH_CODE,
    SUBJECT_HASH,
    USER_AUTH_PREFIX_ENV,
    client_parameter,
    user_parameter,
)
from shared.github_rest import GITHUB_API_VERSION
from shared.invocation_cost import measure_invocation_cost
from shared.logging import logger
from shared.model_fallback import error_code

EXCHANGE: Final = 'exchange'
#: GitHub's OAuth host and the token endpoint (a code's exchange, a refresh).
OAUTH_HOST: Final = 'github.com'
ACCESS_ENDPOINT: Final = '/login/oauth/access_token'
API_HOST: Final = 'api.github.com'
#: A token is refreshed this long before it expires.
REFRESH_MARGIN_SECONDS: Final = 300
REQUEST_TIMEOUT_SECONDS: Final = 5.0
#: A user access token and a refresh token (GitHub's OAuth code takes the manifest code's rule, github_apps.py CODE).
_ACCESS_TOKEN: Final = re.compile(r'gh[uo]_[A-Za-z0-9_]{16,251}')
_REFRESH_TOKEN: Final = re.compile(r'ghr_[A-Za-z0-9_]{16,251}')
_FIELDS: Final = frozenset({'action', 'app_id', 'subject_hash', 'code', 'redirect_uri'})
NOT_AUTHORIZED: Final = ("The connection owner has not authorized the GitHub App (or removed it): they authorize it "
                         'under Agents → Connections → GitHub Apps → Authorize as me.')
EXPIRED: Final = ("The connection owner's GitHub authorization has expired or was revoked on GitHub: they authorize "
                  'the App again under Agents → Connections.')


class UserAuthRefused(Exception):
    """A request this function does not take (another action, a field off its shape): raised before anything is read."""


class ClientUnavailable(Exception):
    """The App's OAuth client is not stored here (an App made before 7.57.00 needs its client id and a new secret)."""


class AuthorizationRefused(Exception):
    """GitHub refused the code (expired, used, or for another App or address): authorize again."""


@dataclass(frozen=True)
class Client:
    client_id: str
    client_secret: str = field(repr=False)


@dataclass(frozen=True)
class Tokens:
    """A person's tokens as GitHub answered them (``repr`` leaves both out); an expiry of 0: none (an App whose
    user tokens do not expire)."""

    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: int = 0
    refresh_expires_at: int = 0


def _iso(epoch: int) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat() if epoch else ''


def _epoch(text: object) -> int:
    if not isinstance(text, str) or not text:
        return 0
    try:
        return int(datetime.fromisoformat(text).timestamp())
    except ValueError:
        return 0


def _seconds(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def tokens_of(data: object, now: float) -> Tokens | None:
    """GitHub's token answer (an exchange or a refresh), or None when it is a refusal or off its shape."""
    access, refresh = dig(data, 'access_token'), dig(data, 'refresh_token')
    if not isinstance(access, str) or not _ACCESS_TOKEN.fullmatch(access):
        return None
    if refresh is not None and not (isinstance(refresh, str) and _REFRESH_TOKEN.fullmatch(refresh)):
        return None
    expires, refresh_expires = _seconds(dig(data, 'expires_in')), _seconds(dig(data, 'refresh_token_expires_in'))
    return Tokens(access_token=access, refresh_token=refresh or '',
                  expires_at=int(now) + expires if expires else 0,
                  refresh_expires_at=int(now) + refresh_expires if refresh_expires else 0)


def user_value(app_id: str, user_id: int, login: str, tokens: Tokens) -> str:
    """A person's parameter JSON."""
    return json.dumps({'app_id': app_id, 'user_id': user_id, 'login': login, 'access_token': tokens.access_token,
                       'expires_at': _iso(tokens.expires_at), 'refresh_token': tokens.refresh_token,
                       'refresh_token_expires_at': _iso(tokens.refresh_expires_at)})


def _client_of(text: str, app_id: str) -> Client | None:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    client_id, secret = dig(value, 'client_id'), dig(value, 'client_secret')
    if (dig(value, 'app_id') != app_id or not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id)
            or not isinstance(secret, str) or not CLIENT_SECRET.fullmatch(secret)):
        return None
    return Client(client_id=client_id, client_secret=secret)


@lru_cache(maxsize=1)
def _ssm() -> Any:
    return boto3.client('ssm')


class GitHubOAuth:
    """GitHub's token endpoint (``github.com``) and the user read (``api.github.com``), each over its own bound
    transport (tests inject fakes)."""

    def __init__(self, oauth: Transport | None = None, api: Transport | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._oauth = oauth or HttpsTransport(timeout=REQUEST_TIMEOUT_SECONDS, host=OAUTH_HOST)
        self._api = api or HttpsTransport(timeout=REQUEST_TIMEOUT_SECONDS, host=API_HOST)
        self._clock = clock

    def _token_request(self, fields: Mapping[str, str]) -> object:
        headers = {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
                   'User-Agent': 'voc-engineering-user-auth'}
        response = self._oauth.request('POST', ACCESS_ENDPOINT, headers, urlencode(dict(fields)).encode())
        return _answer(response, 'the token request')

    def exchange(self, client: Client, code: str, redirect_uri: str) -> Tokens:
        data = self._token_request({'client_id': client.client_id, 'client_secret': client.client_secret,
                                    'code': code, 'redirect_uri': redirect_uri})
        tokens = tokens_of(data, self._clock())
        if tokens is None:
            raise AuthorizationRefused('GitHub did not take this authorization (it is good for ten minutes, once): '
                                       'authorize again from Agents → Connections')
        return tokens

    def refresh(self, client: Client, refresh_token: str) -> Tokens | None:
        data = self._token_request({'client_id': client.client_id, 'client_secret': client.client_secret,
                                    'grant_type': 'refresh_token', 'refresh_token': refresh_token})
        return tokens_of(data, self._clock())

    def user(self, access_token: str) -> tuple[int, str]:
        headers = {'Accept': 'application/vnd.github+json', 'Authorization': f'Bearer {access_token}',
                   'User-Agent': 'voc-engineering-user-auth', 'X-GitHub-Api-Version': GITHUB_API_VERSION}
        data = _answer(self._api.request('GET', '/user', headers, None), 'the user read')
        user_id, login = dig(data, 'id'), dig(data, 'login')
        if not isinstance(user_id, int) or not isinstance(login, str) or not GITHUB_LOGIN.fullmatch(login):
            raise HostError('GitHub answered the user read off its shape.')
        return user_id, login


def _answer(response: Response, what: str) -> object:
    if response.status in (429, 403) or response.status >= 500:
        raise HostBusy(f'GitHub is busy ({response.status}) with {what}; retry later.', retry_after=60)
    if response.status != 200:
        failed = HostError(f'GitHub answered {response.status} to {what}.')
        failed.status = response.status
        raise failed
    try:
        return json.loads(response.body)
    except ValueError:
        raise HostError(f'GitHub answered {what} with a body that is not JSON.') from None


def _read(ssm: Any, name: str) -> str | None:
    """A parameter's decrypted value, None when there is none; an AWS failure raises ``HostBusy`` (retry)."""
    try:
        return str(ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value'])
    except ssm.exceptions.ParameterNotFound:
        return None
    except (ClientError, BotoCoreError, KeyError) as error:
        logger.warning('engineering user authorization not read', extra={'error_code': error_code(error)
                                                                         if isinstance(error, ClientError) else ''})
        raise HostBusy('The user authorization could not be read; retry.', retry_after=30) from None


def _put(ssm: Any, name: str, value: str, key_id: str) -> None:
    ssm.put_parameter(Name=name, Value=value, Type='SecureString', KeyId=key_id, Overwrite=True, Tier='Standard')


# --- voc-engineering-user-auth -----------------------------------------------------------------------------------


def parse_exchange(event: object) -> dict[str, str]:
    """The exchange's checked fields, or ``UserAuthRefused`` (nothing read yet)."""
    if not isinstance(event, Mapping) or event.get('action') != EXCHANGE or frozenset(event) != _FIELDS:
        raise UserAuthRefused(f'this function takes {EXCHANGE!r} {{app_id, subject_hash, code, redirect_uri}} only')
    app_id, owner, code, redirect = (event.get(name) for name in ('app_id', 'subject_hash', 'code', 'redirect_uri'))
    if not (isinstance(app_id, str) and APP_NUMBER.fullmatch(app_id)):
        raise UserAuthRefused('app_id is a GitHub App id (digits)')
    if not (isinstance(owner, str) and SUBJECT_HASH.fullmatch(owner)):
        raise UserAuthRefused('subject_hash is a sha256 in hex')
    if not (isinstance(code, str) and OAUTH_CODE.fullmatch(code)):
        raise UserAuthRefused('code is GitHub\'s authorization code')
    if not (isinstance(redirect, str) and redirect.startswith('https://') and redirect.endswith(AUTHORIZED_PATH)
            and len(redirect) <= 300):
        raise UserAuthRefused('redirect_uri is the deployment\'s authorized page over https')
    return {'app_id': app_id, 'subject_hash': owner, 'code': code, 'redirect_uri': redirect}


class UserAuth:
    """The exchange over SSM (``client``) under ``prefix``, encrypted with ``key_id``, and GitHub (``oauth``)."""

    def __init__(self, prefix: str, key_id: str, client: Callable[[], Any] = _ssm, oauth: GitHubOAuth | None = None) \
            -> None:
        self._prefix = prefix
        self._key_id = key_id
        self._client = client
        self._oauth = oauth or GitHubOAuth()

    def exchange(self, app_id: str, owner: str, code: str, redirect_uri: str) -> dict[str, Any]:
        if not (self._prefix and self._key_id):
            raise ClientUnavailable('the deployment names no path or key for the user authorizations')
        ssm = self._client()
        stored = _read(ssm, client_parameter(self._prefix, app_id))
        client = None if stored is None else _client_of(stored, app_id)
        if client is None:
            raise ClientUnavailable('the App\'s OAuth client is not stored here: set its client id and a new client '
                                    'secret under Agents → Connections → GitHub Apps')
        tokens = self._oauth.exchange(client, code, redirect_uri)
        user_id, login = self._oauth.user(tokens.access_token)
        try:
            _put(ssm, user_parameter(self._prefix, app_id, owner), user_value(app_id, user_id, login, tokens),
                 self._key_id)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering user authorization not stored', extra={
                'app_id': app_id, 'error_code': error_code(error) if isinstance(error, ClientError) else ''})
            raise HostBusy('The authorization could not be stored; authorize again.', retry_after=30) from None
        logger.info('engineering user authorization stored', extra={'app_id': app_id, 'user_id': user_id})
        return {'login': login, 'user_id': user_id, 'expires_at': _iso(tokens.expires_at) or None,
                'refresh_token_expires_at': _iso(tokens.refresh_expires_at) or None}


@lru_cache(maxsize=1)
def user_auth(prefix: str, key_id: str) -> UserAuth:
    return UserAuth(prefix, key_id)


@measure_invocation_cost
def lambda_handler(event: object, context: object) -> dict[str, Any]:
    """voc-engineering-user-auth's entry: ``exchange`` alone; anything else is refused before anything is read."""
    try:
        request = parse_exchange(event)
    except UserAuthRefused:
        logger.warning('engineering user auth: a request refused')
        raise
    return user_auth(os.environ.get(USER_AUTH_PREFIX_ENV, ''), os.environ.get(PARAMETER_KEY_ENV, '')).exchange(
        request['app_id'], request['subject_hash'], request['code'], request['redirect_uri'])


# --- the broker's reader ------------------------------------------------------------------------------------------


class OwnerTokens:
    """The broker's ``OwnerTokens``: a connection owner's user token of an App, read from SSM under ``prefix`` for the
    upstream pull request alone (never cached: each use reads it, so a removal holds at once), refreshed when due and
    written back under ``key_id``."""

    def __init__(self, prefix: str, key_id: str, client: Callable[[], Any] = _ssm, oauth: GitHubOAuth | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._prefix = prefix
        self._key_id = key_id
        self._client = client
        self._oauth = oauth or GitHubOAuth()
        self._clock = clock

    def _stored(self, app_id: str, owner: str) -> dict[str, Any]:
        if not (self._prefix and APP_NUMBER.fullmatch(app_id) and SUBJECT_HASH.fullmatch(owner)):
            raise OwnerUnauthorized(NOT_AUTHORIZED)
        text = _read(self._client(), user_parameter(self._prefix, app_id, owner))
        try:
            value = json.loads(text) if text is not None else None
        except ValueError:
            value = None
        if not isinstance(value, dict) or value.get('app_id') != app_id:
            raise OwnerUnauthorized(NOT_AUTHORIZED)
        return value

    def _fresh(self, value: Mapping[str, Any]) -> OwnerToken | None:
        token, expires = value.get('access_token'), _epoch(value.get('expires_at'))
        if not isinstance(token, str) or not _ACCESS_TOKEN.fullmatch(token):
            return None
        if expires and expires - self._clock() < REFRESH_MARGIN_SECONDS:
            return None
        return OwnerToken(token=token, login=str(value.get('login') or ''))

    def token(self, app_id: str, owner: str) -> OwnerToken:
        value = self._stored(app_id, owner)
        fresh = self._fresh(value)
        if fresh is not None:
            return fresh
        refreshed = self._refresh(app_id, owner, value)
        if refreshed is not None:
            return refreshed
        again = self._fresh(self._stored(app_id, owner))   # (another container may have refreshed it first)
        if again is None:
            raise OwnerUnauthorized(EXPIRED)
        return again

    def _refresh(self, app_id: str, owner: str, value: Mapping[str, Any]) -> OwnerToken | None:
        refresh = value.get('refresh_token')
        refresh_expires = _epoch(value.get('refresh_token_expires_at'))
        if not isinstance(refresh, str) or not _REFRESH_TOKEN.fullmatch(refresh) or (
                refresh_expires and refresh_expires <= self._clock()):
            return None
        ssm = self._client()
        stored = _read(ssm, client_parameter(self._prefix, app_id))
        client = None if stored is None else _client_of(stored, app_id)
        if client is None:
            return None
        tokens = self._oauth.refresh(client, refresh)
        if tokens is None:
            return None
        user_id, login = value.get('user_id'), str(value.get('login') or '')
        try:
            _put(ssm, user_parameter(self._prefix, app_id, owner),
                 user_value(app_id, user_id if isinstance(user_id, int) else 0, login, tokens), self._key_id)
        except (ClientError, BotoCoreError) as error:
            # (the new tokens are used once now; the next use refreshes again and may find the rotated refresh
            # token refused: the owner then authorizes again)
            logger.warning('engineering user authorization refresh not stored', extra={
                'app_id': app_id, 'error_code': error_code(error) if isinstance(error, ClientError) else ''})
        logger.info('engineering user authorization refreshed', extra={'app_id': app_id})
        return OwnerToken(token=tokens.access_token, login=login)
