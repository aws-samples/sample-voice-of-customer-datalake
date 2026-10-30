"""Cognito ACCESS-token verification for the global MCP server (docs/mcp.md → "OAuth sign-in").

RS256 only, through ``cryptography`` (``lambda/layers/signing-deps``): the header's ``alg`` must be
``RS256`` and its ``kid`` a key of the pool's JWKS — ``none``, HS256 and every other algorithm are
refused before any key is touched. Then the claims: ``iss`` is the pool, ``token_use`` is ``access``,
``client_id`` is one of the MCP app clients (never the web app's), ``exp`` is in the future, ``iat`` is
not, ``aud`` — when present — is the canonical MCP URL, and the token carries ``sub``, ``username``
and ``origin_jti`` (the refresh chain the grant pins).

The JWKS is fetched from the fixed ``COGNITO_ISSUER`` URL (never from the token), cached for an hour
and re-read at most once a minute for an unknown ``kid`` (key rotation). A JWKS that cannot be read is
:class:`JwksUnavailable` — a server fault (500), never a 401 that would send a client to sign in again.

Never logs a token or a claim value.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from shared.mcp_oauth_config import OAuthConfig, canonical_url

JWKS_TTL_SECONDS: Final = 3600
JWKS_REFRESH_FLOOR_SECONDS: Final = 60
JWKS_TIMEOUT_SECONDS: Final = 3
# Clock skew tolerated on `iat` (a token "from the future").
IAT_LEEWAY_SECONDS: Final = 60
MAX_TOKEN_LENGTH: Final = 8192
MIN_RSA_BITS: Final = 2048


class InvalidToken(Exception):
    """The credential is not a usable MCP access token (a 401). The message names the check, never a value."""


class JwksUnavailable(Exception):
    """The signing keys could not be read: the token cannot be checked either way (a 500)."""


def _b64url(segment: str) -> bytes:
    if not segment or '=' in segment:
        raise InvalidToken('malformed segment')
    try:
        return base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4))
    except (binascii.Error, ValueError) as exc:
        raise InvalidToken('malformed segment') from exc


def _json_segment(segment: str) -> dict[str, Any]:
    try:
        value = json.loads(_b64url(segment))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InvalidToken('malformed segment') from exc
    if not isinstance(value, dict):
        raise InvalidToken('malformed segment')
    return value


def _int_from_b64url(segment: object) -> int:
    if not isinstance(segment, str):
        raise ValueError('not a string')
    return int.from_bytes(_b64url(segment), 'big')


def public_key_from_jwk(jwk: Mapping[str, Any]) -> rsa.RSAPublicKey | None:
    """The RSA verification key of one JWKS entry, or None when it is not an RS256 signing key."""
    if jwk.get('kty') != 'RSA' or jwk.get('use', 'sig') != 'sig' or jwk.get('alg', 'RS256') != 'RS256':
        return None
    try:
        key = rsa.RSAPublicNumbers(_int_from_b64url(jwk.get('e')), _int_from_b64url(jwk.get('n'))).public_key()
    except (InvalidToken, ValueError):
        return None
    return key if key.key_size >= MIN_RSA_BITS else None


def _fetch_jwks(url: str) -> dict[str, Any]:
    try:
        response = requests.get(url, timeout=JWKS_TIMEOUT_SECONDS, allow_redirects=False)
        response.raise_for_status()
        document = response.json()
    except (requests.RequestException, ValueError) as exc:
        raise JwksUnavailable(type(exc).__name__) from exc
    if not isinstance(document, dict) or not isinstance(document.get('keys'), list):
        raise JwksUnavailable('not a JWKS document')
    return document


@dataclass
class JwksCache:
    """The pool's signing keys by ``kid``; ``fetch`` and ``clock`` are injectable for tests."""

    fetch: Callable[[str], dict[str, Any]] = _fetch_jwks
    clock: Callable[[], float] = time.monotonic
    _keys: dict[str, rsa.RSAPublicKey] = field(default_factory=dict)
    _url: str = ''
    _fetched_at: float | None = None

    def _refresh(self, url: str) -> None:
        document = self.fetch(url)
        keys: dict[str, rsa.RSAPublicKey] = {}
        for jwk in document.get('keys', []):
            if isinstance(jwk, dict) and isinstance(jwk.get('kid'), str):
                key = public_key_from_jwk(jwk)
                if key is not None:
                    keys[jwk['kid']] = key
        self._keys, self._url, self._fetched_at = keys, url, self.clock()

    def key(self, url: str, kid: str) -> rsa.RSAPublicKey | None:
        now = self.clock()
        age = None if self._fetched_at is None or self._url != url else now - self._fetched_at
        if age is None or age >= JWKS_TTL_SECONDS or (kid not in self._keys and age >= JWKS_REFRESH_FLOOR_SECONDS):
            self._refresh(url)
        return self._keys.get(kid)


_default_cache = JwksCache()


def _verified_payload(token: str, config: OAuthConfig, cache: JwksCache) -> dict[str, Any]:
    if len(token) > MAX_TOKEN_LENGTH or token.count('.') != 2:
        raise InvalidToken('not a JWT')
    header_b64, payload_b64, signature_b64 = token.split('.')
    header = _json_segment(header_b64)
    if header.get('alg') != 'RS256':
        raise InvalidToken('unsupported algorithm')
    kid = header.get('kid')
    if not isinstance(kid, str) or not kid:
        raise InvalidToken('no key id')
    key = cache.key(config.jwks_uri, kid)
    if key is None:
        raise InvalidToken('unknown key id')
    try:
        key.verify(_b64url(signature_b64), f'{header_b64}.{payload_b64}'.encode('ascii'),
                   padding.PKCS1v15(), hashes.SHA256())
    except (InvalidSignature, UnicodeEncodeError) as exc:
        raise InvalidToken('bad signature') from exc
    return _json_segment(payload_b64)


def _numeric(claims: Mapping[str, Any], name: str) -> int:
    value = claims.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidToken(f'no {name}')
    return value


def _require_text(claims: Mapping[str, Any], name: str) -> str:
    value = claims.get(name)
    if not isinstance(value, str) or not value:
        raise InvalidToken(f'no {name}')
    return value


def _check_audience(claims: Mapping[str, Any], resource: str) -> None:
    """``aud`` is optional (Cognito sets it only for a ``resource``-bound token); present, it must match."""
    if 'aud' not in claims:
        return
    audiences = claims['aud'] if isinstance(claims['aud'], list) else [claims['aud']]
    if not audiences or any(canonical_url(audience) != resource for audience in audiences):
        raise InvalidToken('wrong audience')


@dataclass(frozen=True)
class AccessClaims:
    """What the MCP server uses from a verified access token."""

    sub: str
    username: str
    client_id: str
    origin_jti: str
    scopes: frozenset[str]
    expires_at: int


def verify_access_token(token: str, config: OAuthConfig, *, now: float,
                        cache: JwksCache | None = None) -> AccessClaims:
    """The verified claims of an MCP access token; raises InvalidToken (401) or JwksUnavailable (500)."""
    claims = _verified_payload(token, config, cache or _default_cache)
    if claims.get('iss') != config.cognito_issuer:
        raise InvalidToken('wrong issuer')
    if claims.get('token_use') != 'access':
        raise InvalidToken('not an access token')
    client_id = _require_text(claims, 'client_id')
    if client_id not in config.client_ids:
        raise InvalidToken('not an MCP client')
    expires_at = _numeric(claims, 'exp')
    if expires_at <= now:
        raise InvalidToken('expired')
    if _numeric(claims, 'iat') > now + IAT_LEEWAY_SECONDS:
        raise InvalidToken('issued in the future')
    _check_audience(claims, config.resource)
    scope = claims.get('scope')
    return AccessClaims(
        sub=_require_text(claims, 'sub'),
        username=_require_text(claims, 'username'),
        client_id=client_id,
        origin_jti=_require_text(claims, 'origin_jti'),
        scopes=frozenset(scope.split()) if isinstance(scope, str) else frozenset(),
        expires_at=expires_at,
    )


def unverified_claims(token: object) -> dict[str, Any] | None:
    """The payload of a JWT WITHOUT checking its signature, or None.

    Only for a token this service received DIRECTLY from Cognito's token endpoint over TLS (the token
    facade, which reads ``sub`` / ``client_id`` / ``origin_jti`` to record the grant's chain). Never for
    a token a client presented.
    """
    if not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH or token.count('.') != 2:
        return None
    try:
        return _json_segment(token.split('.')[1])
    except InvalidToken:
        return None
