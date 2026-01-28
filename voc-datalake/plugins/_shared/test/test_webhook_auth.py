"""Tests for webhook_auth.py - Webhook signature verification."""
import os
import json
import hmac
import hashlib
import pytest
from unittest.mock import patch, MagicMock


class TestVerifyHmacSha256:
    """Tests for verify_hmac_sha256() function."""

    def test_returns_true_for_valid_signature(self):
        """Verifies correct HMAC-SHA256 signature."""
        from _shared.webhook_auth import verify_hmac_sha256
        
        payload = b'{"test": "data"}'
        secret = 'my-secret-key'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload,
            hashlib.sha256
        ).hexdigest()
        
        assert verify_hmac_sha256(payload, signature, secret) is True

    def test_returns_false_for_invalid_signature(self):
        """Rejects incorrect signature."""
        from _shared.webhook_auth import verify_hmac_sha256
        
        payload = b'{"test": "data"}'
        secret = 'my-secret-key'
        wrong_signature = 'invalid-signature-here'
        
        assert verify_hmac_sha256(payload, wrong_signature, secret) is False

    def test_returns_false_for_wrong_secret(self):
        """Rejects signature made with different secret."""
        from _shared.webhook_auth import verify_hmac_sha256
        
        payload = b'{"test": "data"}'
        correct_secret = 'correct-secret'
        wrong_secret = 'wrong-secret'
        
        signature = hmac.new(
            correct_secret.encode('utf-8'),
            payload,
            hashlib.sha256
        ).hexdigest()
        
        assert verify_hmac_sha256(payload, signature, wrong_secret) is False

    def test_handles_case_insensitive_comparison(self):
        """Compares signatures case-insensitively."""
        from _shared.webhook_auth import verify_hmac_sha256
        
        payload = b'test'
        secret = 'secret'
        signature = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
        
        # Should match uppercase version
        assert verify_hmac_sha256(payload, signature.upper(), secret) is True


class TestVerifyGenericSignature:
    """Tests for verify_generic_signature() function."""

    def test_verifies_generic_hmac_signature(self):
        """Verifies generic webhook signature using HMAC-SHA256."""
        from _shared.webhook_auth import verify_generic_signature
        
        payload = b'{"eventType": "webhook-event"}'
        secret = 'webhook-secret'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload,
            hashlib.sha256
        ).hexdigest()
        
        assert verify_generic_signature(payload, signature, secret) is True


class TestVerifyGithubSignature:
    """Tests for verify_github_signature() function."""

    def test_verifies_github_signature_with_prefix(self):
        """Verifies GitHub webhook signature with sha256= prefix."""
        from _shared.webhook_auth import verify_github_signature
        
        payload = b'{"action": "push"}'
        secret = 'github-webhook-secret'
        raw_sig = hmac.new(
            secret.encode('utf-8'),
            payload,
            hashlib.sha256
        ).hexdigest()
        signature = f'sha256={raw_sig}'
        
        assert verify_github_signature(payload, signature, secret) is True

    def test_rejects_signature_without_prefix(self):
        """Rejects GitHub signature missing sha256= prefix."""
        from _shared.webhook_auth import verify_github_signature
        
        payload = b'{"action": "push"}'
        secret = 'github-webhook-secret'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload,
            hashlib.sha256
        ).hexdigest()  # No prefix
        
        assert verify_github_signature(payload, signature, secret) is False


class TestVerifyStripeSignature:
    """Tests for verify_stripe_signature() function."""

    def test_verifies_stripe_signature_format(self):
        """Verifies Stripe webhook signature with timestamp."""
        from _shared.webhook_auth import verify_stripe_signature
        
        payload = b'{"type": "payment_intent.succeeded"}'
        secret = 'whsec_stripe_secret'
        timestamp = '1609459200'
        
        signed_payload = f'{timestamp}.{payload.decode("utf-8")}'
        sig = hmac.new(
            secret.encode('utf-8'),
            signed_payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        signature = f't={timestamp},v1={sig}'
        
        assert verify_stripe_signature(payload, signature, secret) is True

    def test_rejects_invalid_stripe_format(self):
        """Rejects malformed Stripe signature."""
        from _shared.webhook_auth import verify_stripe_signature
        
        payload = b'{"type": "payment"}'
        secret = 'whsec_secret'
        signature = 'invalid-format'
        
        assert verify_stripe_signature(payload, signature, secret) is False

    def test_rejects_missing_timestamp(self):
        """Rejects Stripe signature without timestamp."""
        from _shared.webhook_auth import verify_stripe_signature
        
        payload = b'{"type": "payment"}'
        secret = 'whsec_secret'
        signature = 'v1=somesignature'  # Missing t=
        
        assert verify_stripe_signature(payload, signature, secret) is False


class TestRequireWebhookSignatureDecorator:
    """Tests for @require_webhook_signature decorator."""

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    def test_allows_request_with_valid_signature(self):
        """Passes through to handler when signature valid."""
        from _shared.webhook_auth import require_webhook_signature
        
        payload = '{"test": "data"}'
        secret = 'test-secret'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        event = {
            'body': payload,
            'headers': {'X-Webhook-Signature': signature},
            'isBase64Encoded': False,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 200

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    def test_rejects_request_with_invalid_signature(self):
        """Returns 401 when signature invalid."""
        from _shared.webhook_auth import require_webhook_signature
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        event = {
            'body': '{"test": "data"}',
            'headers': {'X-Webhook-Signature': 'wrong-signature'},
            'isBase64Encoded': False,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 401
        assert 'Invalid signature' in result['body']

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    def test_rejects_request_without_signature_header(self):
        """Returns 401 when signature header missing."""
        from _shared.webhook_auth import require_webhook_signature
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        event = {
            'body': '{"test": "data"}',
            'headers': {},  # No signature header
            'isBase64Encoded': False,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 401
        assert 'Missing signature' in result['body']

    @patch.dict(os.environ, {'WEBHOOK_SECRET': ''})
    def test_returns_500_when_secret_not_configured(self):
        """Returns 500 when WEBHOOK_SECRET not set."""
        from _shared.webhook_auth import require_webhook_signature
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        event = {
            'body': '{"test": "data"}',
            'headers': {'X-Webhook-Signature': 'some-sig'},
            'isBase64Encoded': False,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 500
        assert 'configuration error' in result['body']

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    def test_handles_case_insensitive_header_lookup(self):
        """Finds signature header regardless of case."""
        from _shared.webhook_auth import require_webhook_signature
        
        payload = '{"test": "data"}'
        secret = 'test-secret'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        # Header with different case
        event = {
            'body': payload,
            'headers': {'x-webhook-signature': signature},  # lowercase
            'isBase64Encoded': False,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 200

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    def test_handles_base64_encoded_body(self):
        """Decodes base64 body before verification."""
        import base64
        from _shared.webhook_auth import require_webhook_signature
        
        payload = '{"test": "data"}'
        secret = 'test-secret'
        signature = hmac.new(
            secret.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        @require_webhook_signature('generic', 'X-Webhook-Signature')
        def handler(event, context):
            return {'statusCode': 200, 'body': 'OK'}
        
        event = {
            'body': base64.b64encode(payload.encode()).decode(),
            'headers': {'X-Webhook-Signature': signature},
            'isBase64Encoded': True,
        }
        
        result = handler(event, None)
        
        assert result['statusCode'] == 200


class TestSignatureVerifierRegistry:
    """Tests for SIGNATURE_VERIFIERS registry."""

    def test_contains_generic_verifier(self):
        """Registry includes generic verifier."""
        from _shared.webhook_auth import SIGNATURE_VERIFIERS
        
        assert 'generic' in SIGNATURE_VERIFIERS

    def test_contains_github_verifier(self):
        """Registry includes github verifier."""
        from _shared.webhook_auth import SIGNATURE_VERIFIERS
        
        assert 'github' in SIGNATURE_VERIFIERS

    def test_contains_stripe_verifier(self):
        """Registry includes stripe verifier."""
        from _shared.webhook_auth import SIGNATURE_VERIFIERS
        
        assert 'stripe' in SIGNATURE_VERIFIERS

    def test_contains_generic_hmac_verifier(self):
        """Registry includes generic hmac_sha256 verifier."""
        from _shared.webhook_auth import SIGNATURE_VERIFIERS
        
        assert 'hmac_sha256' in SIGNATURE_VERIFIERS
