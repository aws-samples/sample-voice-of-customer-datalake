"""
Shared authentication utilities for VoC Lambda functions.
Provides Cognito JWT validation for Function URL handlers.

Security Controls:
- Cryptographic signature verification using PyJWT with RS256 algorithm allowlist
- Token issuer validation against configured User Pool
- Token expiration validation
- Token type validation (id/access tokens only)

The JWT validation follows AWS Cognito best practices:
https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
"""

import json
import os
from functools import wraps

import jwt
from jwt import PyJWKClient, PyJWKClientError

from shared.logging import logger

# Environment configuration
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Security: Only allow RS256 algorithm (prevents algorithm confusion attacks)
ALLOWED_ALGORITHMS = ["RS256"]
JWKS_CACHE_TTL_SECONDS = 3600

# Cached JWKS client (reused across Lambda invocations)
_jwks_client: PyJWKClient | None = None


def _get_signing_key(token: str):
    """Get the signing key for a token from JWKS."""
    global _jwks_client
    if not USER_POOL_ID:
        return None
    if _jwks_client is None:
        jwks_url = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True, lifespan=JWKS_CACHE_TTL_SECONDS)
    return _jwks_client.get_signing_key_from_jwt(token)


def validate_cognito_token(token: str) -> tuple[bool, str, dict | None]:
    """
    Validate a Cognito JWT token using PyJWT.
    
    Returns (is_valid, error_message, claims).
    """
    if not USER_POOL_ID:
        logger.warning("Cognito validation skipped - USER_POOL_ID not configured")
        return True, "", None
    
    try:
        signing_key = _get_signing_key(token)
        if signing_key is None:
            return True, "", None
        
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=ALLOWED_ALGORITHMS,
            issuer=f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}",
            options={"require": ["exp", "iss", "token_use"]}
        )
        
        # Cognito-specific: validate token_use claim
        if claims.get('token_use') not in ('id', 'access'):
            return False, "Invalid token type", None
        
        return True, "", claims
        
    except jwt.ExpiredSignatureError:
        return False, "Token expired", None
    except jwt.ImmatureSignatureError:
        return False, "Token not yet valid", None
    except jwt.InvalidIssuerError:
        return False, "Invalid token issuer", None
    except jwt.InvalidSignatureError:
        return False, "Invalid token signature", None
    except jwt.DecodeError:
        return False, "Invalid token format", None
    except PyJWKClientError as e:
        logger.warning(f"JWKS client error: {e}")
        return False, "Invalid token signature", None
    except jwt.InvalidTokenError as e:
        logger.warning(f"Token validation error: {e}")
        return False, str(e), None


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
