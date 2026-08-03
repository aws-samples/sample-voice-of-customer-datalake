"""
CloudFront signed-URL minting for the private `/avatars/*` and `/prototypes/*`
cache behaviors (issue #229).

Those two paths live on the SPA's CloudFront distribution, which has to stay
publicly reachable to serve the login page, so they used to be world-readable:
Cognito is enforced at API Gateway, never at the CDN. They are now restricted
by a CloudFront trusted key group, and this module mints the short-lived signed
URLs that the already-authenticated API hands back to the browser.

WHY SIGNED URLS AND NOT SIGNED COOKIES
`<img src>` and `<iframe src>` cannot carry an Authorization header, so the
choice was cookies or URLs. Cookies looked cheaper until the delivery problem:
`cloudfront.net` and `execute-api.<region>.amazonaws.com` are both entries on
the Public Suffix List, so an API Gateway response has NO `Domain=` value that
can set a cookie for the distribution's host. Signed URLs sidestep that
entirely, need no cookie lifecycle in the SPA, and — because the
CachingOptimized policy keeps query strings out of the cache key — do not
fragment the edge cache per viewer.

WHY RSA-SHA1
CloudFront's signature format requires it. That rules out `kms:Sign`, whose RSA
options are SHA-256/384/512 only, hence the local private key plus
`cryptography` rather than a KMS-held key.

FAILS CLOSED. With signing unconfigured or broken, callers get None and the
frontend degrades (avatars fall back to a gradient). Returning an UNSIGNED URL
instead would silently restore the very hole this closes, so it is never done —
including in local/mock development, which has no CloudFront at all.
"""
import os
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from botocore.signers import CloudFrontSigner
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from shared.aws import get_secret
from shared.logging import logger

# Env is read inside the accessors below, not captured at import time, so tests
# can set it with monkeypatch without reimporting the module (same reason
# shared/avatar.py reads AVATARS_CDN_URL inside get_avatar_cdn_url).

# Matched to the Cognito token lifetime: a signed URL should not outlive the
# session that asked for it. Long enough that a page left open keeps working,
# short enough that a leaked or logged URL stops working soon.
FALLBACK_TTL_SECONDS = 3600


def _signing_secret_arn() -> str:
    """Secret holding {"privateKeyPem": ..., "publicKeyPem": ...}, written at
    deploy time by the cdn_signing_keys custom resource."""
    return os.environ.get('CDN_SIGNING_SECRET_ARN', '')


def _signing_key_pair_id() -> str:
    """CloudFront public key id — the `Key-Pair-Id` query parameter, NOT the KMS
    or IAM notion of a key id."""
    return os.environ.get('CDN_SIGNING_KEY_PAIR_ID', '')


def _default_ttl_seconds() -> int:
    raw = os.environ.get('CDN_SIGNED_URL_TTL_SECONDS', '')
    try:
        ttl = int(raw)
    except (TypeError, ValueError):
        return FALLBACK_TTL_SECONDS
    # A non-positive TTL would mint URLs that are already expired, which looks
    # exactly like a broken key. Treat it as misconfiguration and fall back.
    return ttl if ttl > 0 else FALLBACK_TTL_SECONDS


def is_configured() -> bool:
    """True when this Lambda has everything it needs to sign."""
    return bool(_signing_secret_arn() and _signing_key_pair_id())


@lru_cache(maxsize=1)
def _load_private_key():
    """Parse the signing key once per container.

    Cached because the parse is pure CPU on every avatar in a project payload,
    and because `get_secret` is itself cached — without this the key would be
    re-parsed for each URL.
    """
    secret = get_secret(_signing_secret_arn())
    private_key_pem = (secret or {}).get('privateKeyPem')
    if not private_key_pem:
        raise ValueError('signing secret has no privateKeyPem')
    return serialization.load_pem_private_key(private_key_pem.encode('utf-8'), password=None)


@lru_cache(maxsize=1)
def _signer() -> CloudFrontSigner:
    private_key = _load_private_key()

    def rsa_signer(message: bytes) -> bytes:
        return private_key.sign(message, padding.PKCS1v15(), hashes.SHA1())

    return CloudFrontSigner(_signing_key_pair_id(), rsa_signer)


def clear_signer_cache() -> None:
    """Drop the cached key and signer. For tests and forced rotation."""
    _load_private_key.cache_clear()
    _signer.cache_clear()


def sign_url(url: str, ttl_seconds: int | None = None) -> str | None:
    """Return `url` with a CloudFront signature appended, or None.

    None means "do not hand this URL to a browser": either signing is not
    configured or the key could not be loaded. Callers treat that as "no
    asset", never as "use the bare URL".

    Args:
        url: Absolute https URL on the distribution, e.g.
            https://d111.cloudfront.net/avatars/persona_1.jpeg
        ttl_seconds: Validity window; defaults to DEFAULT_TTL_SECONDS.

    Returns:
        Signed URL, or None if it could not be signed.
    """
    if not url:
        return None
    if not is_configured():
        logger.error(
            'CloudFront URL signing is not configured; refusing to return an '
            'unsigned URL for a private CDN path',
            extra={
                'has_secret': bool(_signing_secret_arn()),
                'has_key_pair_id': bool(_signing_key_pair_id()),
            },
        )
        return None

    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=ttl_seconds if ttl_seconds is not None else _default_ttl_seconds()
    )
    try:
        return _signer().generate_presigned_url(url, date_less_than=expires_at)
    except Exception as e:  # noqa: BLE001 — see below
        # Deliberately broad. The failure modes span botocore errors, a
        # malformed PEM, and crypto backend errors, and the correct response to
        # all of them is identical: log it and return None. Narrowing this risks
        # an uncaught type escaping and failing the whole project request over
        # one unsignable avatar — and the one thing we must never do on the
        # error path is fall through to the unsigned URL.
        logger.exception(f'Failed to sign CloudFront URL: {e}')
        return None
