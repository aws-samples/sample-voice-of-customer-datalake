"""
Webhook signature verification for different providers.
Each provider has its own signing method.
"""

import hmac
import hashlib
import base64
import os
from typing import Callable
from functools import wraps

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shared.logging import logger


class WebhookAuthError(Exception):
    """Raised when webhook signature verification fails."""
    pass


def verify_hmac_sha256(payload: bytes, signature: str, secret: str) -> bool:
    """Verify HMAC-SHA256 signature (common format)."""
    expected = hmac.new(
        secret.encode("utf-8"),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected.lower(), signature.lower())


def verify_generic_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify generic webhook signature (HMAC-SHA256)."""
    return verify_hmac_sha256(payload, signature, secret)


def verify_github_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook signature (HMAC-SHA256 with sha256= prefix)."""
    if not signature.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"),
        payload,
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected.lower(), signature.lower())


def verify_stripe_signature(payload: bytes, signature: str, secret: str) -> bool:
    """Verify Stripe webhook signature (timestamp + HMAC-SHA256)."""
    # Stripe uses t=timestamp,v1=signature format
    try:
        parts = dict(item.split("=", 1) for item in signature.split(","))
        timestamp = parts.get("t")
        sig = parts.get("v1")
        if not timestamp or not sig:
            return False

        signed_payload = f"{timestamp}.{payload.decode('utf-8')}"
        expected = hmac.new(
            secret.encode("utf-8"),
            signed_payload.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected.lower(), sig.lower())
    except Exception:
        return False


def verify_slack_signature(payload: bytes, signature: str, secret: str, timestamp: str = "") -> bool:
    """Verify Slack webhook signature."""
    if not timestamp:
        return False
    
    sig_basestring = f"v0:{timestamp}:{payload.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        secret.encode("utf-8"),
        sig_basestring.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected.lower(), signature.lower())


# Registry of verification methods per provider
SIGNATURE_VERIFIERS: dict[str, Callable[[bytes, str, str], bool]] = {
    "generic": verify_generic_signature,
    "github": verify_github_signature,
    "stripe": verify_stripe_signature,
    "hmac_sha256": verify_hmac_sha256,
}


def require_webhook_signature(provider: str, header_name: str = "X-Signature"):
    """
    Decorator to require webhook signature verification.
    
    Usage:
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def lambda_handler(event, context):
            ...
    """
    def decorator(handler: Callable):
        @wraps(handler)
        def wrapper(event: dict, context):
            import json
            
            # Get signature from headers (case-insensitive)
            headers = event.get("headers", {})
            signature = None
            for key, value in headers.items():
                if key.lower() == header_name.lower():
                    signature = value
                    break

            if not signature:
                logger.warning(f"Missing signature header: {header_name}")
                return {
                    "statusCode": 401,
                    "body": json.dumps({"error": "Missing signature header"})
                }

            # Get webhook secret from environment
            secret = os.environ.get("WEBHOOK_SECRET", "")
            if not secret:
                logger.error("WEBHOOK_SECRET not configured")
                return {
                    "statusCode": 500,
                    "body": json.dumps({"error": "Server configuration error"})
                }

            # Get raw body
            body = event.get("body", "")
            if event.get("isBase64Encoded"):
                body = base64.b64decode(body)
            elif isinstance(body, str):
                body = body.encode("utf-8")

            # Verify signature
            verifier = SIGNATURE_VERIFIERS.get(provider)
            if not verifier:
                logger.error(f"No signature verifier for provider: {provider}")
                return {
                    "statusCode": 500,
                    "body": json.dumps({"error": "Server configuration error"})
                }

            if not verifier(body, signature, secret):
                logger.warning(f"Invalid webhook signature from {provider}")
                return {
                    "statusCode": 401,
                    "body": json.dumps({"error": "Invalid signature"})
                }

            # Signature valid, proceed with handler
            return handler(event, context)

        return wrapper
    return decorator
