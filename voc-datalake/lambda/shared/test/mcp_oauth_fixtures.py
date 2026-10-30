"""Test fixtures for MCP OAuth: a deployment environment, a local RSA signing key and a JWT builder.

Every token here is signed with a key generated for the test session, published through a stubbed
JWKS (``jwks_cache()``), never fetched from Cognito.
"""
from __future__ import annotations

import base64
import json
import os
import time
from collections.abc import Generator
from contextlib import contextmanager
from functools import lru_cache
from typing import Any
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from shared.mcp_oauth_jwt import JwksCache

API = 'https://abc123.execute-api.us-east-1.amazonaws.com/v1'
RESOURCE = f'{API}/mcp/global'
COGNITO_ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_e2e'
COGNITO_DOMAIN = 'https://voc-example.auth.us-east-1.amazoncognito.com'
FRONTEND = 'https://app.example.com'
CLIENTS = {'kiro': 'kiro-client', 'claude-code': 'claude-client', 'cursor': 'cursor-client', 'web': 'web-client'}
CURSOR_WEB_CALLBACK = 'https://www.cursor.com/agents/mcp/oauth/callback'
WEB_CALLBACK = 'https://assistant.example.com/oauth/callback'
KID = 'test-kid'

OAUTH_ENV = {
    'MCP_RESOURCE_URL': RESOURCE,
    'MCP_OAUTH_ISSUER': API,
    'MCP_OAUTH_CLIENTS': json.dumps(CLIENTS),
    'MCP_OAUTH_CURSOR_CALLBACKS': json.dumps([CURSOR_WEB_CALLBACK]),
    'MCP_OAUTH_WEB_CALLBACKS': json.dumps([WEB_CALLBACK]),
    'COGNITO_DOMAIN_URL': COGNITO_DOMAIN,
    'COGNITO_ISSUER': COGNITO_ISSUER,
    'FRONTEND_URL': FRONTEND,
    'MCP_OAUTH_FORWARD_RESOURCE': 'false',
}


@contextmanager
def oauth_env(**overrides: str) -> Generator[None, None, None]:
    with patch.dict(os.environ, {**OAUTH_ENV, **overrides}):
        yield


@lru_cache(maxsize=2)
def signing_key(name: str = 'main') -> rsa.RSAPrivateKey:
    del name  # one cached key per name
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _int_b64(value: int) -> str:
    return _b64(value.to_bytes((value.bit_length() + 7) // 8, 'big'))


def jwk(key: rsa.RSAPrivateKey | None = None, kid: str = KID) -> dict[str, str]:
    numbers = (key or signing_key()).public_key().public_numbers()
    return {'kty': 'RSA', 'kid': kid, 'alg': 'RS256', 'use': 'sig', 'n': _int_b64(numbers.n), 'e': _int_b64(numbers.e)}


def jwks_cache(*keys: dict[str, str]) -> JwksCache:
    published = list(keys) or [jwk()]
    return JwksCache(fetch=lambda _url: {'keys': published})


def access_claims(**overrides: Any) -> dict[str, Any]:
    now = int(time.time())
    claims: dict[str, Any] = {
        'sub': 'sub-alice', 'username': 'alice', 'client_id': CLIENTS['kiro'], 'token_use': 'access',
        'iss': COGNITO_ISSUER, 'iat': now, 'exp': now + 3600, 'origin_jti': 'chain-1',
        'scope': f'openid {RESOURCE}/read {RESOURCE}/write', 'jti': 'jti-1',
    }
    claims.update(overrides)
    return {k: v for k, v in claims.items() if v is not None}


def sign(claims: dict[str, Any], *, key: rsa.RSAPrivateKey | None = None,
         header: dict[str, Any] | None = None) -> str:
    head = header if header is not None else {'alg': 'RS256', 'kid': KID, 'typ': 'JWT'}
    signing_input = f'{_b64(json.dumps(head).encode())}.{_b64(json.dumps(claims).encode())}'
    signature = (key or signing_key()).sign(signing_input.encode(), padding.PKCS1v15(), hashes.SHA256())
    return f'{signing_input}.{_b64(signature)}'


def unsigned(claims: dict[str, Any], alg: str = 'none') -> str:
    head = _b64(json.dumps({'alg': alg, 'kid': KID}).encode())
    return f'{head}.{_b64(json.dumps(claims).encode())}.'
