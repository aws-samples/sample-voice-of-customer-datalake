"""voc-engineering-app-tokens (7.45.00; docs/autonomous-engineering.md, "Repository connectors": "A GitHub App in two
clicks"): the one function that signs with a deployment's GitHub App key outside the broker.

It runs the broker's code (``credentials.parse_app_key``, ``github.sign_app_jwt``) under a role of its own, with the
signing layer, and takes two actions, each a direct invoke (the stack: lib/stacks/engineering-app-tokens.ts), and
refuses every other, and any request off its shape, before anything is read (``AppTokensRefused``):

* ``inspect_installation`` ``{app_id, installation_id}``, the Agents API's (``github_apps.py``): the installation as
  the App's JWT reads it (GitHub's ``/app/installations/<id>``: an installation of another App answers 404 there, and
  one whose ``app_id`` differs or that is suspended is refused alike, ``InstallationRefused``), then its repositories,
  read with an installation token of ``{metadata: read}`` alone, which is revoked before the answer (a ``DELETE`` of
  GitHub's ``/installation/token``). The answer, ``{account: {login, type}, repositories: [{repository, private,
  archived, default_branch}], truncated}``, never carries a token;
* ``issues_token`` ``{app_id, repositories}``, the github_issues ingestor's (a deployment-wide run's sign-in with an
  App): for each repository the installation that covers it (GitHub's ``/repos/<owner>/<name>/installation`` read
  with the JWT; a 404 is not covered, answered in ``uncovered``), then one installation token per installation with exactly
  ``{issues: read, metadata: read}`` and ``repositories`` narrowed to the run's ones it covers. The answer,
  ``{tokens: [{repositories, token, expires_at}], uncovered}``, is the ingestor's, which revokes each token at the
  end of its run. A request naming a workspace is refused: a workspace's run signs in with its own token, the
  deployment's Apps are the deployment's (D8, until 3g3).

The App's key is read from ``{prefix}_github-app/<app_id>/key`` (its App id checked) and kept ``CACHE_SECONDS``; a key
that cannot be read is ``AppKeyUnavailable``. The key, the JWT and any token are never logged or put in an error; a
host failure is ``HostBusy`` (rate limited, unreachable) or ``HostError`` (any other answer), naming the call and the
status only. Every request goes to ``api.github.com`` through the broker's transport (no redirect, a path never a URL).
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import Any, Final
from urllib.parse import urlencode

import boto3
from cryptography.hazmat.primitives.asymmetric import rsa

from engineering.connectors.connections import PARAMETER_PREFIX_ENV, REPOSITORY, github_number
from engineering.connectors.credentials import AppKeys, CredentialUnusable
from engineering.connectors.github import API_HOST, METADATA_READ, TOKEN_PATH, send_request, sign_app_jwt
from engineering.connectors.hosts import HostError, NoConnection
from engineering.connectors.transport import HttpsTransport, Response, Transport, dig, json_of, text_of
from shared.logging import logger

INSPECT: Final = 'inspect_installation'
ISSUES_ACTION: Final = 'issues_token'
ACTIONS: Final = frozenset({INSPECT, ISSUES_ACTION})
#: Exactly what the Issues source's token may do (the plan's, pinned by test_app_tokens.py).
ISSUES_PERMISSIONS: Final = {'issues': 'read', 'metadata': 'read'}
#: What an inspection's token may do: list the installation's repositories, nothing else (the broker's metadata read).
INSPECT_PERMISSIONS: Final = METADATA_READ
#: The most repositories an Issues source names (plugins/_shared/github_config.py MAX_REPOS).
MAX_REPOSITORIES: Final = 20
#: An inspection reads at most this many pages of 100 repositories (more is answered ``truncated``).
MAX_PAGES: Final = 10
PAGE_SIZE: Final = 100
#: Each request's timeout: an inspection answers the Agents API, which waits 25 s.
REQUEST_TIMEOUT_SECONDS: Final = 5.0
#: The keys a request may carry besides ``action``; a workspace's is named so its refusal says why.
_INSPECT_FIELDS: Final = frozenset({'action', 'app_id', 'installation_id'})
_ISSUES_FIELDS: Final = frozenset({'action', 'app_id', 'repositories'})
_WORKSPACE_FIELDS: Final = frozenset({'workspace', 'workspace_id', 'ws'})
#: The installation answers' refusal (another App's, gone, suspended): one sentence for each, never the id read.
OTHER_APP: Final = ('this installation belongs to another GitHub App, or is gone: install this App from Agents → '
                    'Connections')
SUSPENDED: Final = 'this installation is suspended on GitHub: unsuspend it in its settings, then check it again'


class AppTokensRefused(Exception):
    """A request this function does not take: another action, a field off its shape, a workspace. Raised before
    anything is read."""


class AppKeyUnavailable(Exception):
    """The App's key is not stored here, or not readable (the message never quotes it)."""


class InstallationRefused(Exception):
    """The installation is not this App's (GitHub answers 404 to its JWT), or it is suspended."""


def _number(value: object, name: str) -> str:
    """An App's or an installation's id (``connections.github_number``), or ``AppTokensRefused`` naming ``name``."""
    text = github_number(value)
    if text is None:
        raise AppTokensRefused(f'{name} is a GitHub id (digits)')
    return text


def _repositories(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_REPOSITORIES:
        raise AppTokensRefused(f'repositories is a list of 1 to {MAX_REPOSITORIES} owner/name')
    found: dict[str, str] = {}
    for item in value:
        match = REPOSITORY.fullmatch(item) if isinstance(item, str) else None
        if match is None or match.group('name') in {'.', '..'}:
            raise AppTokensRefused('repositories is a list of owner/name')
        found.setdefault(item.lower(), item)
    return tuple(found.values())


def parse_request(event: object) -> tuple[str, dict[str, Any]]:
    """The action and its checked arguments, or ``AppTokensRefused`` (nothing read yet)."""
    action = event.get('action') if isinstance(event, Mapping) else None
    if action not in ACTIONS or not isinstance(event, Mapping):
        raise AppTokensRefused(f'this function takes {INSPECT!r} or {ISSUES_ACTION!r} only')
    if _WORKSPACE_FIELDS & set(event):
        raise AppTokensRefused('a workspace\'s run signs in with its own token: the GitHub Apps are the deployment\'s')
    if action == INSPECT:
        if set(event) != _INSPECT_FIELDS:
            raise AppTokensRefused('the request is {action, app_id, installation_id}')
        return action, {'app_id': _number(event['app_id'], 'app_id'),
                        'installation_id': int(_number(event['installation_id'], 'installation_id'))}
    if set(event) != _ISSUES_FIELDS:
        raise AppTokensRefused('the request is {action, app_id, repositories}')
    return action, {'app_id': _number(event['app_id'], 'app_id'), 'repositories': _repositories(event['repositories'])}


@lru_cache(maxsize=1)
def _ssm() -> Any:
    return boto3.client('ssm')


class AppTokens:
    """The two actions over the App keys under ``prefix`` (SSM through ``client``) and GitHub (``transport``)."""

    def __init__(self, prefix: str, client: Callable[[], Any] = _ssm, transport: Transport | None = None,
                 clock: Callable[[], float] = time.time, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._prefix = prefix
        self._client = client
        self._transport = transport or HttpsTransport(timeout=REQUEST_TIMEOUT_SECONDS, host=API_HOST,
                                                      repeatable=TOKEN_PATH)
        self._clock = clock
        self._keys = AppKeys(prefix, client, monotonic)

    # --- the App's key and GitHub ---------------------------------------------------------------------------

    def _key(self, app_id: str) -> rsa.RSAPrivateKey:
        if not self._prefix:
            raise AppKeyUnavailable('the deployment names no parameter path for the GitHub Apps\' keys')
        try:
            return self._keys.get(app_id)
        except CredentialUnusable:
            raise AppKeyUnavailable('the App\'s stored key is unusable: remove the App and create it again') from None
        except NoConnection:
            raise AppKeyUnavailable('the App\'s key is not stored here: remove the App and create it again') from None

    def _jwt(self, app_id: str) -> str:
        return f'Bearer {sign_app_jwt(app_id, self._key(app_id), self._clock())}'

    def _send(self, method: str, path: str, authorization: str, what: str, body: object = None,
              ok: tuple[int, ...] = (200,)) -> Response:
        return send_request(self._transport, self._clock, method, path, authorization, what, body=body, ok=ok,
                            user_agent='voc-engineering-app-tokens')

    def _mint(self, jwt: str, installation_id: int, permissions: Mapping[str, str],
              repositories: list[str] | None = None) -> tuple[str, str]:
        """An installation token for ``permissions`` (and ``repositories``' names, when given): (token, expires_at)."""
        body: dict[str, Any] = {'permissions': dict(permissions)}
        if repositories is not None:
            body['repositories'] = repositories
        data = json_of(self._send('POST', f'/app/installations/{installation_id}/access_tokens', jwt,
                                  'the token request', body=body, ok=(201,)))
        return text_of(data, 'token'), text_of(data, 'expires_at')

    def _revoke(self, token: str) -> None:
        """Revoke ``token`` (sent once); a revocation that fails is logged, never raised: the token expires within the
        hour."""
        try:
            self._send('DELETE', '/installation/token', f'Bearer {token}', 'the token revocation', ok=(204,))
        except HostError as error:
            logger.warning('engineering GitHub App token not revoked', extra={'status': error.status})

    # --- the actions ------------------------------------------------------------------------------------------

    def inspect(self, app_id: str, installation_id: int) -> dict[str, Any]:
        """The installation's account and repositories, read with a revoked ``metadata: read`` token (never answered)."""
        jwt = self._jwt(app_id)
        found = self._send('GET', f'/app/installations/{installation_id}', jwt, 'the installation read', ok=(200, 404))
        if found.status == 404:
            raise InstallationRefused(OTHER_APP)
        data = json_of(found)
        if str(dig(data, 'app_id')) != app_id:
            raise InstallationRefused(OTHER_APP)
        if dig(data, 'suspended_at') is not None:
            raise InstallationRefused(SUSPENDED)
        account = {'login': text_of(dig(data, 'account'), 'login'), 'type': text_of(dig(data, 'account'), 'type')}
        token, _ = self._mint(jwt, installation_id, INSPECT_PERMISSIONS)
        try:
            repositories, truncated = self._repositories(token)
        finally:
            self._revoke(token)
        logger.info('engineering GitHub App installation inspected',
                    extra={'app_id': app_id, 'installation_id': installation_id, 'repositories': len(repositories)})
        return {'account': account, 'repositories': repositories, 'truncated': truncated}

    def _repositories(self, token: str) -> tuple[list[dict[str, Any]], bool]:
        found: list[dict[str, Any]] = []
        for page in range(1, MAX_PAGES + 1):
            query = urlencode({'per_page': PAGE_SIZE, 'page': page})
            data = json_of(self._send('GET', f'/installation/repositories?{query}', f'Bearer {token}',
                                      'the repositories read'))
            listed = dig(data, 'repositories')
            items = listed if isinstance(listed, list) else []
            for item in items:
                name = dig(item, 'full_name')
                match = REPOSITORY.fullmatch(name) if isinstance(name, str) else None
                if match is None:
                    continue
                branch = dig(item, 'default_branch')
                found.append({'repository': name, 'private': dig(item, 'private') is True,
                              'archived': dig(item, 'archived') is True,
                              'default_branch': branch if isinstance(branch, str) else ''})
            total = dig(data, 'total_count')
            if len(items) < PAGE_SIZE or (isinstance(total, int) and len(found) >= total):
                return found, False
        return found, True

    def issues(self, app_id: str, repositories: tuple[str, ...]) -> dict[str, Any]:
        """One ``{issues: read, metadata: read}`` token per installation covering the run's ``repositories``, each
        narrowed to the ones it covers; the rest ``uncovered``. A failure revokes the tokens already minted."""
        jwt = self._jwt(app_id)
        covered: dict[int, list[str]] = {}
        uncovered: list[str] = []
        for repository in repositories:
            found = self._send('GET', f'/repos/{repository}/installation', jwt, 'the installation lookup',
                               ok=(200, 404))
            data = None if found.status == 404 else json_of(found)
            installation = dig(data, 'id')
            if (data is None or not isinstance(installation, int) or str(dig(data, 'app_id')) != app_id
                    or dig(data, 'suspended_at') is not None):
                uncovered.append(repository)
                continue
            covered.setdefault(installation, []).append(repository)
        tokens: list[dict[str, Any]] = []
        try:
            for installation, names in covered.items():
                token, expires_at = self._mint(jwt, installation, ISSUES_PERMISSIONS,
                                               [name.split('/', 1)[1] for name in names])
                tokens.append({'repositories': names, 'token': token, 'expires_at': expires_at})
        except Exception:
            for minted in tokens:
                self._revoke(minted['token'])
            raise
        logger.info('engineering GitHub App issues tokens minted',
                    extra={'app_id': app_id, 'tokens': len(tokens), 'uncovered': len(uncovered)})
        return {'tokens': tokens, 'uncovered': uncovered}


@lru_cache(maxsize=1)
def app_tokens(prefix: str) -> AppTokens:
    """The container's (one, so a read key stays warm ``CACHE_SECONDS``)."""
    return AppTokens(prefix)


def lambda_handler(event: object, context: object) -> dict[str, Any]:
    """voc-engineering-app-tokens' entry: ``inspect_installation`` or ``issues_token``; anything else, and a request
    off its shape, is refused (``AppTokensRefused``) before the key or GitHub is read."""
    try:
        action, request = parse_request(event)
    except AppTokensRefused:
        logger.warning('engineering app tokens: a request refused',
                       extra={'action': str(event.get('action'))[:40] if isinstance(event, Mapping) else ''})
        raise
    tokens = app_tokens(os.environ.get(PARAMETER_PREFIX_ENV, ''))
    if action == INSPECT:
        return tokens.inspect(request['app_id'], request['installation_id'])
    return tokens.issues(request['app_id'], request['repositories'])
