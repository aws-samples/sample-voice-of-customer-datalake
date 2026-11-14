"""A CloudFront-signed URL for the uploaded company logo, for the invitation email (auth/user_messages.py).

The logo is private (signed-only CDN path ``/company-context/design/logo_<12>.<ext>``, lib/stacks/core-cdn.ts
COMPANY_LOGO_PATH_PATTERN). An email cannot carry an Authorization header, Cognito caps the message at
20,000 characters (no inline image), and an S3 presigned URL minted here would die with this function's
session credentials within hours. A CloudFront signature, made with the distribution's own key pair
(the same one shared/cloudfront_signing.py uses for avatars and prototypes), can last as long as the
invitation: ``TEMP_PASSWORD_DAYS``.

The signature is a bearer credential for that window: anyone holding the email can fetch the logo, and
nothing else, until it expires.

FAILS CLOSED, and never raises: unconfigured signing, an unreadable secret, a key that is not RSA, or no
``cryptography`` (the signing-deps layer) all mean None, and the email is sent without a logo. An unsigned
URL is never returned: the CDN path refuses it anyway.

Self-contained (stdlib + boto3 + the layer's cryptography, imported lazily) so the trigger bundle stays
two files; it does not import shared/cloudfront_signing.py, which pulls in Powertools.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from botocore.signers import CloudFrontSigner

logger = logging.getLogger(__name__)

#: An uploaded logo's object key, exactly (shared/company_logo.py _UPLOADED_LOGO_KEY_RE, the CDN path pattern).
UPLOADED_LOGO_KEY = re.compile(r'company-context/design/logo_[0-9a-f]{12}\.(?:png|jpg|webp)')


def is_uploaded_logo_key(value: Any) -> bool:
    return isinstance(value, str) and UPLOADED_LOGO_KEY.fullmatch(value) is not None


_signer_cache: list = []  # the built signer, once: a FAILURE is not cached, so a transient error is retried


def _rsa_signer():
    """``message -> RSA-SHA1 signature`` with the CDN signing key, or None when it cannot be built now."""
    if _signer_cache:
        return _signer_cache[0]
    signer = _build_rsa_signer()
    if signer is not None:
        _signer_cache.append(signer)
    return signer


def _build_rsa_signer():
    try:
        # Both always set by the stack (core-auth.ts); a missing one fails closed like any other gap.
        secret_arn = os.environ['CDN_SIGNING_SECRET_ARN']
        key_pair_id = os.environ['CDN_SIGNING_KEY_PAIR_ID']
    except KeyError:
        return None
    if not (secret_arn and key_pair_id):
        return None
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
    except ImportError:
        logger.warning('Logo signing unavailable: cryptography is not installed (signing-deps layer)')
        return None
    try:
        secret = json.loads(boto3.client('secretsmanager').get_secret_value(SecretId=secret_arn)['SecretString'])
        key = serialization.load_pem_private_key(secret['privateKeyPem'].encode('utf-8'), password=None)
    except (BotoCoreError, ClientError, KeyError, TypeError, ValueError) as error:
        logger.warning('Logo signing unavailable: %s', type(error).__name__)
        return None
    if not isinstance(key, rsa.RSAPrivateKey):
        logger.warning('Logo signing unavailable: the CDN signing key is not RSA')
        return None
    return lambda message: key.sign(message, padding.PKCS1v15(), hashes.SHA1())  # noqa: S303 - CloudFront's format


def signed_logo_url(key: Any, site_url: str, valid_days: int, *, now: datetime | None = None) -> str | None:
    """The logo at ``site_url`` + ``/`` + ``key``, signed until ``valid_days`` from ``now``; None when it cannot be."""
    if not is_uploaded_logo_key(key) or not site_url.startswith('https://') or valid_days <= 0:
        return None
    signer = _rsa_signer()
    if signer is None:
        return None
    expires = (now or datetime.now(UTC)) + timedelta(days=valid_days)
    url = f'{site_url.rstrip("/")}/{key}'
    return CloudFrontSigner(os.environ['CDN_SIGNING_KEY_PAIR_ID'], signer).generate_presigned_url(
        url, date_less_than=expires)
