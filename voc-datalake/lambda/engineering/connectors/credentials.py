"""A connection's GitHub App credential (docs/autonomous-engineering.md, "Repository connectors": credentials).

One SSM Parameter Store SecureString per connection, ``{prefix}{connection_id}`` (CDK hands the prefix down:
``/[<prefix>-]voc/engineering/``), encrypted with the stack's customer-managed key and holding JSON::

    {"app_id": "123456", "installation_id": 7890123, "repository": "owner/name", "private_key": "-----BEGIN ..."}

Only the broker reads it, decrypted, and keeps it in memory for ``CACHE_SECONDS`` at most. The value is never
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

from engineering.connectors.hosts import NO_CONNECTION, NoConnection
from shared.logging import logger
from shared.model_fallback import error_code

#: The broker's env var with the parameters' prefix (``/voc/engineering/``; lib/stacks/engineering-broker.ts).
PARAMETER_PREFIX_ENV: Final = 'ENGINEERING_PARAMETER_PREFIX'
#: How long a read credential is kept: a replaced key reaches a warm container within this.
CACHE_SECONDS: Final = 300
#: A connection id: what a parameter name may hold after the prefix (no ``/``, so never another path).
_CONNECTION_ID: Final = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')
_DIGITS: Final = re.compile(r'[1-9][0-9]{0,19}')
#: ``owner/name`` as GitHub spells them.
_REPOSITORY: Final = re.compile(r'(?P<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})/(?P<name>[A-Za-z0-9._-]{1,100})')


class CredentialUnusable(NoConnection):
    """The connection's parameter is not a GitHub App credential (the message never quotes it)."""


@dataclass(frozen=True)
class GitHubAppCredential:
    """A connection's GitHub App: its id, the installation on the repository, and the App's private key."""

    app_id: str
    installation_id: int
    owner: str
    repository: str
    private_key: rsa.RSAPrivateKey = field(repr=False)


def _field(value: dict[str, Any], key: str) -> str:
    raw = value.get(key)
    return str(raw) if isinstance(raw, (str, int)) and not isinstance(raw, bool) else ''


def parse_credential(text: str) -> GitHubAppCredential:
    """The credential a parameter's JSON value holds, or ``CredentialUnusable``."""
    try:
        value = json.loads(text)
    except ValueError:
        raise CredentialUnusable(NO_CONNECTION) from None
    if not isinstance(value, dict):
        raise CredentialUnusable(NO_CONNECTION)
    app_id, installation_id = _field(value, 'app_id'), _field(value, 'installation_id')
    repository = _REPOSITORY.fullmatch(_field(value, 'repository'))
    if not (_DIGITS.fullmatch(app_id) and _DIGITS.fullmatch(installation_id)) or repository is None \
            or repository.group('name') in {'.', '..'}:
        raise CredentialUnusable(NO_CONNECTION)
    try:
        key = serialization.load_pem_private_key(_field(value, 'private_key').encode(), password=None)
    except (ValueError, TypeError):
        raise CredentialUnusable(NO_CONNECTION) from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise CredentialUnusable(NO_CONNECTION)
    return GitHubAppCredential(app_id=app_id, installation_id=int(installation_id), owner=repository.group('owner'),
                               repository=repository.group('name'), private_key=key)


@lru_cache(maxsize=1)
def _ssm() -> Any:
    return boto3.client('ssm')


class ParameterStoreCredentials:
    """The connections' credentials from SSM, each kept ``CACHE_SECONDS`` in this container."""

    def __init__(self, prefix: str, client: Callable[[], Any] = _ssm,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._prefix = prefix
        self._client = client
        self._clock = clock
        self._cache: dict[str, tuple[float, GitHubAppCredential]] = {}

    def get(self, connection_id: str) -> GitHubAppCredential:
        """``connection_id``'s credential, or ``NoConnection`` when it has none this broker can use."""
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
            credential = parse_credential(str(parameter.get('Parameter', {}).get('Value', '')))
        except CredentialUnusable:
            logger.warning('engineering connection credential unusable', extra={'connection_id': connection_id})
            raise
        self._cache[connection_id] = (self._clock() + CACHE_SECONDS, credential)
        return credential
