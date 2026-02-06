"""
Tests for shared/auth.py - Cognito JWT validation for VoC Lambda functions.

Uses real RS256 signatures - no mocking of crypto functions.
"""

import json
import time
import pytest
from unittest.mock import patch, MagicMock
from cryptography.hazmat.primitives.asymmetric import rsa
import jwt


# Generate a test RSA key pair (2048-bit, same as Cognito)
_private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_public_key = _private_key.public_key()


def make_signed_token(claims: dict, kid: str = "test-key-id") -> str:
    """Create a real RS256-signed JWT."""
    return jwt.encode(claims, _private_key, algorithm="RS256", headers={"kid": kid})


def valid_claims(token_use: str = "access") -> dict:
    return {
        "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
        "token_use": token_use,
        "exp": int(time.time()) + 3600,
        "sub": "user-123",
        "email": "test@example.com",
    }


@pytest.fixture(autouse=True)
def setup_env():
    """Set up module state for each test."""
    import shared.auth as auth_module
    auth_module._jwks_client = None
    auth_module.USER_POOL_ID = "us-east-1_test"
    auth_module.AWS_REGION = "us-east-1"


@pytest.fixture
def mock_jwks():
    """Mock PyJWKClient to return our test public key."""
    mock_signing_key = MagicMock()
    mock_signing_key.key = _public_key
    
    with patch("shared.auth._get_signing_key", return_value=mock_signing_key):
        yield


class TestValidateAuth:
    """Tests for validate_auth with real RS256 signatures."""

    def test_valid_token_accepted(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is True
        assert error == ""

    def test_tampered_payload_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        # Tamper with the payload (change middle part)
        parts = token.split('.')
        tampered = f"{parts[0]}.eyJmb28iOiJiYXIifQ.{parts[2]}"
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {tampered}"}})
        
        assert is_valid is False
        assert "signature" in error.lower()

    def test_wrong_key_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        # Sign with a different key
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = jwt.encode(valid_claims(), other_key, algorithm="RS256", headers={"kid": "test-key-id"})
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is False
        assert "signature" in error.lower()

    def test_missing_authorization_header(self):
        from shared.auth import validate_auth
        
        is_valid, error = validate_auth({"headers": {}})
        
        assert is_valid is False
        assert "Authorization" in error

    def test_none_headers_handled(self):
        from shared.auth import validate_auth
        
        is_valid, error = validate_auth({"headers": None})
        
        assert is_valid is False

    def test_bearer_prefix_stripped(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        
        is_valid, _ = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is True

    def test_raw_token_accepted(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        
        is_valid, _ = validate_auth({"headers": {"Authorization": token}})
        
        assert is_valid is True

    def test_case_insensitive_authorization_header(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        
        is_valid, _ = validate_auth({"headers": {"authorization": f"Bearer {token}"}})
        
        assert is_valid is True

    def test_case_insensitive_bearer_prefix(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims())
        
        is_valid, _ = validate_auth({"headers": {"Authorization": f"bearer {token}"}})
        
        assert is_valid is True

    def test_expired_token_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        claims = valid_claims()
        claims["exp"] = int(time.time()) - 600
        token = make_signed_token(claims)
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is False
        assert "expired" in error.lower()

    def test_wrong_issuer_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        claims = valid_claims()
        claims["iss"] = "https://evil.com"
        token = make_signed_token(claims)
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is False
        assert "issuer" in error.lower()

    def test_invalid_token_use_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        claims = valid_claims()
        claims["token_use"] = "refresh"
        token = make_signed_token(claims)
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is False

    def test_id_token_accepted(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims("id"))
        
        is_valid, _ = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is True

    def test_access_token_accepted(self, mock_jwks):
        from shared.auth import validate_auth
        token = make_signed_token(valid_claims("access"))
        
        is_valid, _ = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is True

    def test_malformed_token_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        
        is_valid, error = validate_auth({"headers": {"Authorization": "Bearer not.valid"}})
        
        assert is_valid is False

    def test_skips_validation_when_disabled(self):
        import shared.auth as auth_module
        auth_module.USER_POOL_ID = ""
        
        is_valid, _ = auth_module.validate_auth({"headers": {"Authorization": "any-token"}})
        
        assert is_valid is True

    def test_nbf_future_token_rejected(self, mock_jwks):
        from shared.auth import validate_auth
        claims = valid_claims()
        claims["nbf"] = int(time.time()) + 600
        token = make_signed_token(claims)
        
        is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
        
        assert is_valid is False
        assert "not yet valid" in error.lower()

    def test_unknown_kid_rejected(self):
        from shared.auth import validate_auth
        from jwt import PyJWKClientError
        
        # Mock _get_signing_key to raise PyJWKClientError for unknown kid
        with patch("shared.auth._get_signing_key", side_effect=PyJWKClientError("Key not found")):
            token = make_signed_token(valid_claims(), kid="unknown-key")
            
            is_valid, error = validate_auth({"headers": {"Authorization": f"Bearer {token}"}})
            
            assert is_valid is False
            assert "signature" in error.lower()


class TestUnauthorizedResponse:
    """Tests for unauthorized_response helper."""

    def test_returns_401_status(self):
        from shared.auth import unauthorized_response
        
        result = unauthorized_response()
        
        assert result["statusCode"] == 401

    def test_includes_www_authenticate_header(self):
        from shared.auth import unauthorized_response
        
        result = unauthorized_response()
        
        assert "WWW-Authenticate" in result["headers"]
        assert "Bearer" in result["headers"]["WWW-Authenticate"]

    def test_includes_custom_error_message(self):
        from shared.auth import unauthorized_response
        
        result = unauthorized_response("Custom error")
        body = json.loads(result["body"])
        
        assert body["error"] == "Custom error"

    def test_default_error_message(self):
        from shared.auth import unauthorized_response
        
        result = unauthorized_response()
        body = json.loads(result["body"])
        
        assert body["error"] == "Unauthorized"

    def test_content_type_is_json(self):
        from shared.auth import unauthorized_response
        
        result = unauthorized_response()
        
        assert result["headers"]["Content-Type"] == "application/json"


class TestRequireAuthDecorator:
    """Tests for require_auth decorator."""

    def test_returns_401_when_unauthorized(self):
        from shared.auth import require_auth
        
        @require_auth
        def handler(event, context):
            return {"statusCode": 200}
        
        result = handler({"headers": {}}, None)
        
        assert result["statusCode"] == 401

    def test_passes_through_when_authorized(self, mock_jwks):
        from shared.auth import require_auth
        token = make_signed_token(valid_claims())
        
        @require_auth
        def handler(event, context):
            return {"statusCode": 200, "body": "success"}
        
        result = handler({"headers": {"Authorization": f"Bearer {token}"}}, None)
        
        assert result["statusCode"] == 200
        assert result["body"] == "success"

    def test_preserves_function_name(self):
        from shared.auth import require_auth
        
        @require_auth
        def my_handler(event, context):
            return {"statusCode": 200}
        
        assert my_handler.__name__ == "my_handler"

    def test_returns_error_message_in_401_response(self):
        from shared.auth import require_auth
        
        @require_auth
        def handler(event, context):
            return {"statusCode": 200}
        
        result = handler({"headers": {}}, None)
        body = json.loads(result["body"])
        
        assert "error" in body
