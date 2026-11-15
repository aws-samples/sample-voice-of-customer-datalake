"""A GitHub App credential for tests, its RSA key generated at test time (no key is ever committed)."""
from __future__ import annotations

import json
from functools import lru_cache

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from engineering.connectors.credentials import GitHubAppCredential

APP_ID = '123456'
INSTALLATION_ID = 7890123
OWNER = 'example-org'
REPOSITORY = 'refund-service'


@lru_cache(maxsize=1)
def private_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def pem(key: rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey | None = None) -> str:
    return (key or private_key()).private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                serialization.NoEncryption()).decode()


def parameter_value(**overrides: object) -> str:
    """A connection parameter's JSON value, with ``overrides``."""
    value: dict[str, object] = {'app_id': APP_ID, 'installation_id': INSTALLATION_ID,
                                'repository': f'{OWNER}/{REPOSITORY}', 'private_key': pem()}
    value.update(overrides)
    return json.dumps(value)


def connection_body(**change: object) -> dict[str, object]:
    """A connection save (``PUT /agents/engineering/connections/<id>``) of ``OWNER/REPOSITORY`` with the App's
    credential, its key generated at test time, with ``change``."""
    return {'host': 'github', 'repository': f'{OWNER}/{REPOSITORY}', 'default_branch': 'main',
            'credential': {'app_id': APP_ID, 'installation_id': str(INSTALLATION_ID), 'private_key': pem()},
            **change}


def credential() -> GitHubAppCredential:
    return GitHubAppCredential(app_id=APP_ID, installation_id=INSTALLATION_ID, owner=OWNER, repository=REPOSITORY,
                               private_key=private_key())
