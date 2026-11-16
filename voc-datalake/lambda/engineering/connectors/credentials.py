"""A connection's credential: a GitHub App's, or a GitLab project access token (docs/autonomous-engineering.md,
"Repository connectors": credentials).

One SSM Parameter Store SecureString per connection, written by an administrator's save (``connections.py``, through
the Agents API's ``PUT /agents/engineering/connections/<id>``), ``{prefix}{connection_id}`` (CDK hands the prefix down:
``/[<prefix>-]voc/engineering/``), encrypted with the stack's customer-managed key and holding JSON, a GitHub App's
(a value with no ``host``, as 7.03.00 wrote them, is one)::

    {"app_id": "123456", "installation_id": 7890123, "repository": "owner/name", "private_key": "-----BEGIN ..."}

or, since 7.45.00, a connection made through one of the deployment's GitHub Apps (``github_apps.py``), whose key is
the App's, stored once, named in place of the key::

    {"app_id": "123456", "installation_id": 7890123, "repository": "owner/name", "key": "app"}

which this reader resolves with a second read, of ``{prefix}_github-app/<app_id>/key``
(``{"app_id", "slug", "private_key"}``, its App id checked against the connection's), the key kept like a credential
(``CACHE_SECONDS``: a removed App's key reaches a warm container's runs within that);

or, since 7.06.00, a GitLab project's (its id and path as GitLab answered the save's check, the token's expiry)::

    {"host": "gitlab", "project_id": 4242, "repository": "group/project", "token": "glpat-...", "expires_at": "2027-11-01"}

Only the broker and the checkout cache's writer read it, decrypted, and keep it in memory for ``CACHE_SECONDS`` at
most (the token function, ``app_tokens.py``, reads an App's key alone, by the same ``parse_app_key``). The value is never
logged, echoed or put in an error message: a parameter that is missing, unreadable or not this shape is
``NoConnection`` (503), and the log line names only the connection and the AWS error code.
"""
from __future__ import annotations

import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from engineering.connectors.connections import APP_NUMBER, APP_REFERENCE, REPOSITORY, app_key_parameter
from engineering.connectors.gitlab_api import TOKEN, is_project_path
from engineering.connectors.hosts import NO_CONNECTION, NoConnection
from shared.logging import logger
from shared.model_fallback import error_code

#: How long a read credential is kept: a replaced key reaches a warm container within this.
CACHE_SECONDS: Final = 300
#: A connection id: what a parameter name may hold after the prefix (no ``/``, so never another path).
_CONNECTION_ID: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')


class CredentialUnusable(NoConnection):
    """The connection's parameter is not a credential this reader takes (the message never quotes it)."""


@dataclass(frozen=True)
class GitHubAppCredential:
    """A connection's GitHub App: its id, the installation on the repository, and the App's private key."""

    app_id: str
    installation_id: int
    owner: str
    repository: str
    private_key: rsa.RSAPrivateKey = field(repr=False)


@dataclass(frozen=True)
class GitLabTokenCredential:
    """A connection's GitLab project: its numeric id and its path (``group[/subgroup]/project``), the project access
    token (``repr`` leaves it out) and its expiry (``YYYY-MM-DD``), as the save's check found them."""

    project_id: int
    repository: str
    token: str = field(repr=False)
    expires_at: str = ''


Credential = GitHubAppCredential | GitLabTokenCredential
#: An App's key by the App's id (``ParameterStoreCredentials``' cached read), for a reference's resolution.
AppKeyReader = Callable[[str], rsa.RSAPrivateKey]


def _field(value: dict[str, Any], key: str) -> str:
    raw = value.get(key)
    return str(raw) if isinstance(raw, (str, int)) and not isinstance(raw, bool) else ''


def _json_object(text: str) -> dict[str, Any]:
    try:
        value = json.loads(text)
    except ValueError:
        raise CredentialUnusable(NO_CONNECTION) from None
    if not isinstance(value, dict):
        raise CredentialUnusable(NO_CONNECTION)
    return value


def parse_stored(text: str, app_keys: AppKeyReader | None = None) -> Credential:
    """The credential a parameter's JSON value holds, either host's (``host`` absent: a GitHub App's, its key resolved
    by ``app_keys`` when the value names its App's), or ``CredentialUnusable``."""
    value = _json_object(text)
    if value.get('host', 'github') == 'github':
        return parse_credential(text, app_keys)
    if value.get('host') != 'gitlab':
        raise CredentialUnusable(NO_CONNECTION)
    project_id, repository, token = _field(value, 'project_id'), _field(value, 'repository'), _field(value, 'token')
    if not (APP_NUMBER.fullmatch(project_id) and is_project_path(repository) and TOKEN.fullmatch(token)):
        raise CredentialUnusable(NO_CONNECTION)
    return GitLabTokenCredential(project_id=int(project_id), repository=repository, token=token,
                                 expires_at=_field(value, 'expires_at'))


def _rsa_key(pem: str) -> rsa.RSAPrivateKey:
    try:
        key = serialization.load_pem_private_key(pem.encode(), password=None)
    except (ValueError, TypeError):
        raise CredentialUnusable(NO_CONNECTION) from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise CredentialUnusable(NO_CONNECTION)
    return key


def parse_app_key(text: str, app_id: str) -> rsa.RSAPrivateKey:
    """The RSA key of App ``app_id`` from its key parameter's JSON (``{"app_id", "slug", "private_key"}``), or
    ``CredentialUnusable``: one that names another App's id is unusable (a parameter is never taken for another's)."""
    value = _json_object(text)
    if not APP_NUMBER.fullmatch(app_id) or _field(value, 'app_id') != app_id:
        raise CredentialUnusable(NO_CONNECTION)
    return _rsa_key(_field(value, 'private_key'))


def parse_credential(text: str, app_keys: AppKeyReader | None = None) -> GitHubAppCredential:
    """The GitHub App credential a parameter's JSON value holds, or ``CredentialUnusable`` (a GitLab one included). A
    value naming its App's key (``"key": "app"``, no ``private_key``) is resolved by ``app_keys`` (unusable without)."""
    value = _json_object(text)
    if value.get('host', 'github') != 'github':
        raise CredentialUnusable(NO_CONNECTION)
    app_id, installation_id = _field(value, 'app_id'), _field(value, 'installation_id')
    repository = REPOSITORY.fullmatch(_field(value, 'repository'))
    if not (APP_NUMBER.fullmatch(app_id) and APP_NUMBER.fullmatch(installation_id)) or repository is None \
            or repository.group('name') in {'.', '..'}:
        raise CredentialUnusable(NO_CONNECTION)
    if value.get('key') == APP_REFERENCE:
        if app_keys is None or 'private_key' in value:
            raise CredentialUnusable(NO_CONNECTION)
        key = app_keys(app_id)
    else:
        key = _rsa_key(_field(value, 'private_key'))
    return GitHubAppCredential(app_id=app_id, installation_id=int(installation_id), owner=repository.group('owner'),
                               repository=repository.group('name'), private_key=key)


@lru_cache(maxsize=1)
def _ssm() -> Any:
    return boto3.client('ssm')


class AppKeys:
    """The deployment's GitHub Apps' keys from SSM (``{prefix}_github-app/<app_id>/key``), each kept ``CACHE_SECONDS``
    in this container: the reader of a connection that references its App's key, and the token function's
    (``app_tokens.py``)."""

    def __init__(self, prefix: str, client: Callable[[], Any] = _ssm,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._prefix = prefix
        self._client = client
        self._clock = clock
        self._keys: dict[str, tuple[float, rsa.RSAPrivateKey]] = {}

    def get(self, app_id: str) -> rsa.RSAPrivateKey:
        """App ``app_id``'s key; ``NoConnection`` when it cannot be read, ``CredentialUnusable`` when it is not that
        App's (each logged by the App's id and the AWS error code only)."""
        cached = self._keys.get(app_id)
        if cached is not None and self._clock() < cached[0]:
            return cached[1]
        try:
            parameter = self._client().get_parameter(Name=app_key_parameter(self._prefix, app_id), WithDecryption=True)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering GitHub App key not read', extra={'app_id': app_id, 'error_code': error_code(error)})
            raise NoConnection(NO_CONNECTION) from None
        try:
            key = parse_app_key(str(parameter.get('Parameter', {}).get('Value', '')), app_id)
        except CredentialUnusable:
            logger.warning('engineering GitHub App key unusable', extra={'app_id': app_id})
            raise
        self._keys[app_id] = (self._clock() + CACHE_SECONDS, key)
        return key


class ParameterStoreCredentials:
    """The connections' credentials from SSM, each kept ``CACHE_SECONDS`` in this container."""

    def __init__(self, prefix: str, client: Callable[[], Any] = _ssm,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._prefix = prefix
        self._client = client
        self._clock = clock
        self._cache: dict[str, tuple[float, Credential]] = {}
        #: The deployment's GitHub Apps' keys a reference names, kept as long.
        self._app_keys = AppKeys(prefix, client, clock)

    def get(self, connection_id: str) -> GitHubAppCredential:
        """``connection_id``'s GitHub App credential, or ``NoConnection`` when it has none (a GitLab connection's is
        ``CredentialUnusable`` here): the GitHub client's reader."""
        found = self.stored(connection_id)
        if not isinstance(found, GitHubAppCredential):
            raise CredentialUnusable(NO_CONNECTION)
        return found

    def gitlab(self, connection_id: str) -> GitLabTokenCredential:
        """``connection_id``'s GitLab project and token, or ``NoConnection`` (a GitHub connection's is
        ``CredentialUnusable`` here): the GitLab client's reader."""
        found = self.stored(connection_id)
        if not isinstance(found, GitLabTokenCredential):
            raise CredentialUnusable(NO_CONNECTION)
        return found

    def stored(self, connection_id: str) -> Credential:
        """``connection_id``'s credential, either host's, or ``NoConnection`` when it has none this broker can use."""
        if not self._prefix or not _CONNECTION_ID.fullmatch(connection_id):
            raise NoConnection(NO_CONNECTION)
        cached = self._cache.get(connection_id)
        if cached is not None and self._clock() < cached[0]:
            return cached[1]
        try:
            parameter = self._client().get_parameter(Name=f'{self._prefix}{connection_id}', WithDecryption=True)
        except (ClientError, BotoCoreError) as error:
            logger.warning('engineering connection credential not read',
                           extra={'connection_id': connection_id, 'error_code': error_code(error)})
            raise NoConnection(NO_CONNECTION) from None
        try:
            credential = parse_stored(str(parameter.get('Parameter', {}).get('Value', '')), self._app_keys.get)
        except CredentialUnusable:
            logger.warning('engineering connection credential unusable', extra={'connection_id': connection_id})
            raise
        self._cache[connection_id] = (self._clock() + CACHE_SECONDS, credential)
        return credential
