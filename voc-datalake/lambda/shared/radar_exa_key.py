"""The Exa API key of the Radar news scan (docs/radar.md → "Exa").

Stored as an SSM Parameter Store SecureString (standard tier: no monthly cost; encrypted with the
AWS-managed ``alias/aws/ssm`` key, whose key policy admits any account principal through SSM, so no
KMS grant is needed). The parameter's name comes from ``RADAR_EXA_PARAMETER`` (CDK:
``/[<prefix>-]voc/radar/exa-api-key``), and each role holds only the actions it needs on exactly
that ARN: the Radar API puts, deletes and reads it WITHOUT decryption (``exa_key_configured``),
and the scan reads it decrypted (``load_exa_key``).

The parameter is created by the first ``PUT /radar/settings/exa-key`` and deleted by
``DELETE``. The key itself is never returned, logged or put in an error message.
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import Any, Final

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from shared.exceptions import ConfigurationError
from shared.logging import logger
from shared.model_fallback import error_code

__all__ = ['delete_exa_key', 'exa_key_configured', 'load_exa_key', 'put_exa_key', 'validate_exa_key']

_KEY_RE: Final = re.compile(r'[A-Za-z0-9_-]{8,200}')
_NOT_FOUND: Final = 'ParameterNotFound'


def _parameter_name() -> str:
    return os.environ.get('RADAR_EXA_PARAMETER', '')


@lru_cache(maxsize=1)
def _ssm() -> Any:
    return boto3.client('ssm')


def validate_exa_key(body: object) -> str:
    """The ``api_key`` of a ``{api_key}`` body, or ValueError (whose message never repeats the key)."""
    if not isinstance(body, dict):
        raise ValueError('Request body must be a JSON object')
    raw = body.get('api_key')
    key = raw.strip() if isinstance(raw, str) else ''
    if not _KEY_RE.fullmatch(key):
        raise ValueError('api_key must be 8-200 characters of letters, digits, "_" or "-"')
    return key


def _require_name() -> str:
    name = _parameter_name()
    if not name:
        raise ConfigurationError('The Exa key parameter is not configured')
    return name


def put_exa_key(key: str) -> None:
    """Store (or replace) the key as a SecureString."""
    _ssm().put_parameter(Name=_require_name(), Value=key, Type='SecureString', Overwrite=True, Tier='Standard')


def delete_exa_key() -> None:
    """Remove the key; a key that is not there is already removed."""
    try:
        _ssm().delete_parameter(Name=_require_name())
    except ClientError as error:
        if error_code(error) != _NOT_FOUND:
            raise


def _read(*, decrypt: bool, what: str) -> dict[str, Any] | None:
    """The stored parameter, or None when none is stored or it cannot be read (logged without the value)."""
    name = _parameter_name()
    if not name:
        return None
    try:
        return _ssm().get_parameter(Name=name, WithDecryption=decrypt).get('Parameter') or {}
    except (ClientError, BotoCoreError) as error:
        if (code := error_code(error)) != _NOT_FOUND:
            logger.warning(f'Radar: the Exa key could not be read ({what})', extra={'error_code': code})
    return None


def exa_key_configured() -> bool:
    """Whether a key is stored (read WITHOUT decryption: the value never leaves SSM in clear)."""
    return _read(decrypt=False, what='status') is not None


def load_exa_key() -> str | None:
    """The decrypted key for the scan, or None when none is stored or it cannot be read (never raises)."""
    value = (_read(decrypt=True, what='Exa is skipped') or {}).get('Value')
    return value if isinstance(value, str) and value else None
