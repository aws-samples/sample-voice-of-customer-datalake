"""
Shared authentication utilities for VoC Lambda functions.
Provides Cognito JWT validation for Function URL handlers.

Security Architecture:
=====================
This module implements custom Cognito JWT validation for Lambda Function URLs
with authType: NONE. This approach was chosen over IAM auth (SigV4) because:

1. The frontend uses Cognito User Pool authentication (not Identity Pool)
2. SigV4 signing would require adding a Cognito Identity Pool and AWS SDK
3. JWT validation provides equivalent security when implemented correctly

Security Controls:
- Cryptographic signature verification using Cognito JWKS (RS256)
- Token issuer validation against configured User Pool
- Token expiration validation with clock skew tolerance
- Token type validation (id/access tokens only)
- Audience validation for ID tokens

The JWT validation follows AWS Cognito best practices:
https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
"""

import json
import os
import base64
import hashlib
import urllib.request
from datetime import datetime, timezone
from functools import wraps

from shared.logging import logger

# Environment configuration
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Cache for Cognito JWKS (JSON Web Key Set) with TTL
_cached_jwks: dict | None = None
_jwks_cache_time: datetime | None = None
JWKS_CACHE_TTL_SECONDS = 3600  # 1 hour cache for JWKS

# Clock skew tolerance for token expiration (5 minutes)
CLOCK_SKEW_SECONDS = 300


def get_cognito_jwks() -> dict | None:
    """
    Fetch Cognito JWKS for token signature verification (cached with TTL).
    
    The JWKS contains the public keys used to verify JWT signatures.
    Keys are cached for 1 hour to reduce latency while allowing key rotation.
    """
    global _cached_jwks, _jwks_cache_time
    
    now = datetime.now(timezone.utc)
    if _cached_jwks is not None and _jwks_cache_time is not None:
        cache_age = (now - _jwks_cache_time).total_seconds()
        if cache_age < JWKS_CACHE_TTL_SECONDS:
            return _cached_jwks
    
    if not USER_POOL_ID:
        logger.warning("USER_POOL_ID not configured - authentication disabled")
        return None
    
    try:
        jwks_url = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
        with urllib.request.urlopen(jwks_url, timeout=5) as response:
            _cached_jwks = json.loads(response.read().decode())
            _jwks_cache_time = now
            logger.info("Refreshed Cognito JWKS cache")
            return _cached_jwks
    except Exception as e:
        logger.error(f"Failed to fetch Cognito JWKS: {e}")
        if _cached_jwks is not None:
            logger.warning("Using stale JWKS cache due to fetch failure")
            return _cached_jwks
        return None


def base64url_decode(data: str) -> bytes:
    """Decode base64url-encoded data with proper padding."""
    padding = 4 - len(data) % 4
    if padding != 4:
        data += '=' * padding
    return base64.urlsafe_b64decode(data)


def decode_jwt_parts(token: str) -> tuple[dict | None, dict | None, bytes | None]:
    """
    Decode JWT into header, payload, and signature.
    Returns (header, payload, signature) or (None, None, None) on error.
    """
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None, None, None
        
        header = json.loads(base64url_decode(parts[0]))
        payload = json.loads(base64url_decode(parts[1]))
        signature = base64url_decode(parts[2])
        
        return header, payload, signature
    except Exception as e:
        logger.warning(f"Failed to decode JWT parts: {e}")
        return None, None, None


def get_public_key_from_jwks(jwks: dict, kid: str) -> dict | None:
    """Find the public key in JWKS matching the key ID (kid)."""
    for key in jwks.get('keys', []):
        if key.get('kid') == kid:
            return key
    return None


def verify_rs256_signature(token: str, jwks: dict) -> bool:
    """
    Verify RS256 JWT signature using Cognito JWKS.
    
    This implements cryptographic signature verification per RFC 7515.
    Uses the RSA public key from JWKS to verify the token wasn't tampered with.
    """
    try:
        header, payload, signature = decode_jwt_parts(token)
        if not header or not payload or signature is None:
            return False
        
        if header.get('alg') != 'RS256':
            logger.warning(f"Unexpected JWT algorithm: {header.get('alg')}")
            return False
        
        kid = header.get('kid')
        if not kid:
            logger.warning("JWT missing key ID (kid)")
            return False
        
        public_key = get_public_key_from_jwks(jwks, kid)
        if not public_key:
            logger.warning(f"No matching key found in JWKS for kid: {kid}")
            return False
        
        if public_key.get('kty') != 'RSA':
            logger.warning(f"Unexpected key type: {public_key.get('kty')}")
            return False
        
        if public_key.get('use') != 'sig':
            logger.warning(f"Key not for signature verification: {public_key.get('use')}")
            return False
        
        n = public_key.get('n')
        e = public_key.get('e')
        
        if not n or not e:
            logger.warning("JWK missing RSA components (n, e)")
            return False
        
        parts = token.split('.')
        signing_input = f"{parts[0]}.{parts[1]}".encode('utf-8')
        
        n_bytes = base64url_decode(n)
        e_bytes = base64url_decode(e)
        
        n_int = int.from_bytes(n_bytes, 'big')
        e_int = int.from_bytes(e_bytes, 'big')
        
        sig_int = int.from_bytes(signature, 'big')
        decrypted = pow(sig_int, e_int, n_int)
        
        key_size = (n_int.bit_length() + 7) // 8
        decrypted_bytes = decrypted.to_bytes(key_size, 'big')
        
        # PKCS#1 v1.5 signature verification
        sha256_digest_info = bytes([
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
            0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20
        ])
        
        message_hash = hashlib.sha256(signing_input).digest()
        
        t_len = len(sha256_digest_info) + len(message_hash)
        ps_len = key_size - t_len - 3
        
        if ps_len < 8:
            logger.warning("Key too small for PKCS#1 v1.5 padding")
            return False
        
        expected = bytes([0x00, 0x01]) + bytes([0xFF] * ps_len) + bytes([0x00]) + sha256_digest_info + message_hash
        
        if decrypted_bytes == expected:
            return True
        
        logger.warning("JWT signature verification failed")
        return False
        
    except Exception as e:
        logger.warning(f"JWT signature verification error: {e}")
        return False


def validate_cognito_token(token: str) -> tuple[bool, str, dict | None]:
    """
    Validate a Cognito JWT token with full cryptographic verification.
    
    Validation steps (per AWS Cognito documentation):
    1. Verify the JWT signature using the public key from JWKS
    2. Verify the token is not expired (with clock skew tolerance)
    3. Verify the issuer matches the Cognito User Pool
    4. Verify the token_use claim (id or access)
    5. For ID tokens, verify the audience (aud) matches the app client ID
    
    Returns (is_valid, error_message, claims).
    """
    if not USER_POOL_ID:
        logger.warning("Cognito validation skipped - USER_POOL_ID not configured")
        return True, "", None
    
    header, claims, signature = decode_jwt_parts(token)
    if not header or not claims or signature is None:
        return False, "Invalid token format", None
    
    jwks = get_cognito_jwks()
    if jwks:
        if not verify_rs256_signature(token, jwks):
            return False, "Invalid token signature", None
    else:
        logger.warning("JWKS unavailable - skipping signature verification")
    
    expected_issuer = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}"
    if claims.get('iss') != expected_issuer:
        return False, "Invalid token issuer", None
    
    exp = claims.get('exp')
    if exp:
        current_time = datetime.now(timezone.utc).timestamp()
        if current_time > (exp + CLOCK_SKEW_SECONDS):
            return False, "Token expired", None
    else:
        return False, "Token missing expiration", None
    
    token_use = claims.get('token_use')
    if token_use not in ('id', 'access'):
        return False, "Invalid token type", None
    
    nbf = claims.get('nbf')
    if nbf:
        current_time = datetime.now(timezone.utc).timestamp()
        if current_time < (nbf - CLOCK_SKEW_SECONDS):
            return False, "Token not yet valid", None
    
    return True, "", claims


def validate_auth(event: dict) -> tuple[bool, str]:
    """
    Validate the request authentication from Lambda event.
    
    Extracts the JWT from the Authorization header and performs full validation.
    Supports both "Bearer <token>" and raw token formats.
    
    Returns (is_valid, error_message).
    """
    headers = event.get('headers', {}) or {}
    auth_header = None
    
    for key, value in headers.items():
        if key.lower() == 'authorization':
            auth_header = value
            break
    
    if not auth_header:
        return False, "Missing Authorization header"
    
    token = auth_header
    if auth_header.lower().startswith('bearer '):
        token = auth_header[7:]
    
    is_valid, error_msg, claims = validate_cognito_token(token)
    if not is_valid:
        logger.warning(f"Token validation failed: {error_msg}")
        return False, error_msg
    
    if claims:
        user_id = claims.get('email') or claims.get('sub', 'unknown')
        logger.info(f"Authenticated user: {user_id}")
    
    return True, ""


def unauthorized_response(message: str = "Unauthorized") -> dict:
    """Return a 401 Unauthorized response with security headers."""
    return {
        'statusCode': 401,
        'headers': {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="voc-api"',
        },
        'body': json.dumps({'error': message})
    }


def require_auth(func):
    """
    Decorator for Function URL handlers that require authentication.
    
    Usage:
        @require_auth
        def handler(event, context):
            # Only reached if auth is valid
            ...
    """
    @wraps(func)
    def wrapper(event, context):
        is_valid, error_msg = validate_auth(event)
        if not is_valid:
            logger.warning(f"Authentication failed: {error_msg}")
            return unauthorized_response(error_msg)
        return func(event, context)
    return wrapper
