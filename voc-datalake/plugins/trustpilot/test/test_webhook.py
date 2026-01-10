"""Tests for Trustpilot webhook handler."""
import os
import json
import hmac
import hashlib
import pytest
from unittest.mock import patch, MagicMock


class TestTrustpilotWebhookParsePayload:
    """Tests for parse_webhook_payload() method."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_parses_review_created_event(
        self, mock_get_secret, mock_sqs, mock_trustpilot_webhook_payload
    ):
        """Parses service-review-created event correctly."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        items = webhook.parse_webhook_payload(mock_trustpilot_webhook_payload, {})
        
        assert len(items) == 1
        assert items[0]['id'] == 'webhook-review-456'
        assert items[0]['text'] == 'Product works as expected.'
        assert items[0]['rating'] == 4
        assert items[0]['channel'] == 'review'

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_parses_review_updated_event(self, mock_get_secret, mock_sqs):
        """Parses service-review-updated event with is_update flag."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        
        payload = {
            'eventType': 'service-review-updated',
            'review': {
                'id': 'updated-review-789',
                'createdAt': '2025-01-17T09:00:00Z',
                'stars': 3,
                'text': 'Updated review text',
                'consumer': {'displayName': 'Updated User'},
                'links': [{'href': 'https://trustpilot.com/review/789'}],
            },
        }
        
        items = webhook.parse_webhook_payload(payload, {})
        
        assert len(items) == 1
        assert items[0]['id'] == 'updated-review-789'
        assert items[0]['is_update'] is True

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_parses_review_deleted_event(self, mock_get_secret, mock_sqs):
        """Parses service-review-deleted event with is_deleted flag."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        
        payload = {
            'eventType': 'service-review-deleted',
            'review': {
                'id': 'deleted-review-999',
                'createdAt': '2025-01-10T00:00:00Z',
            },
        }
        
        items = webhook.parse_webhook_payload(payload, {})
        
        assert len(items) == 1
        assert items[0]['id'] == 'deleted-review-999'
        assert items[0]['is_deleted'] is True
        assert items[0]['text'] == ''

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_returns_empty_when_no_review_data(self, mock_get_secret, mock_sqs):
        """Returns empty list when review data missing."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        
        payload = {
            'eventType': 'service-review-created',
            # No 'review' key
        }
        
        items = webhook.parse_webhook_payload(payload, {})
        
        assert items == []

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_extracts_author_from_consumer(self, mock_get_secret, mock_sqs):
        """Extracts author name from consumer.displayName."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        
        payload = {
            'eventType': 'service-review-created',
            'review': {
                'id': 'review-123',
                'createdAt': '2025-01-01T00:00:00Z',
                'stars': 5,
                'text': 'Great!',
                'consumer': {'displayName': 'Alice B.'},
                'links': [{'href': 'https://trustpilot.com/review/123'}],
            },
        }
        
        items = webhook.parse_webhook_payload(payload, {})
        
        assert items[0]['author'] == 'Alice B.'

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_extracts_url_from_links(self, mock_get_secret, mock_sqs):
        """Extracts review URL from links array."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import TrustpilotWebhook
        
        webhook = TrustpilotWebhook()
        
        payload = {
            'eventType': 'service-review-created',
            'review': {
                'id': 'review-123',
                'createdAt': '2025-01-01T00:00:00Z',
                'stars': 5,
                'text': 'Great!',
                'consumer': {'displayName': 'User'},
                'links': [{'href': 'https://trustpilot.com/review/123'}],
            },
        }
        
        items = webhook.parse_webhook_payload(payload, {})
        
        assert items[0]['url'] == 'https://trustpilot.com/review/123'


class TestTrustpilotWebhookLambdaHandler:
    """Tests for lambda_handler with signature verification."""

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_accepts_valid_signature(
        self, mock_audit, mock_get_secret, mock_sqs, mock_trustpilot_webhook_payload, lambda_context
    ):
        """Processes webhook with valid signature."""
        mock_get_secret.return_value = {}
        mock_sqs.return_value = MagicMock()
        
        payload = json.dumps(mock_trustpilot_webhook_payload)
        signature = hmac.new(
            'test-secret'.encode('utf-8'),
            payload.encode('utf-8'),
            hashlib.sha256
        ).hexdigest()
        
        from trustpilot.webhook.handler import lambda_handler
        
        event = {
            'body': payload,
            'headers': {'X-Trustpilot-Signature': signature},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = lambda_handler(event, lambda_context)
        
        assert result['statusCode'] == 200

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_rejects_invalid_signature(self, mock_get_secret, mock_sqs):
        """Returns 401 for invalid signature."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import lambda_handler
        
        event = {
            'body': '{"eventType": "test"}',
            'headers': {'X-Trustpilot-Signature': 'invalid-signature'},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = lambda_handler(event, None)
        
        assert result['statusCode'] == 401

    @patch.dict(os.environ, {'WEBHOOK_SECRET': 'test-secret'})
    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_rejects_missing_signature_header(self, mock_get_secret, mock_sqs):
        """Returns 401 when signature header missing."""
        mock_get_secret.return_value = {}
        
        from trustpilot.webhook.handler import lambda_handler
        
        event = {
            'body': '{"eventType": "test"}',
            'headers': {},  # No signature
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = lambda_handler(event, None)
        
        assert result['statusCode'] == 401
