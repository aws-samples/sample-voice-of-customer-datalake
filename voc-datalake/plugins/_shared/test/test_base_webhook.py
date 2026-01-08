"""Tests for base_webhook.py - Base class for webhook handlers."""
import os
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestBaseWebhookInit:
    """Tests for BaseWebhook initialization."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_loads_secrets_with_plugin_prefix_filtering(
        self, mock_get_secret, mock_sqs
    ):
        """Loads and filters secrets by plugin prefix."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {
            'test_source_webhook_secret': 'secret-123',
            'test_source_api_key': 'key-456',
            'other_plugin_key': 'should-not-include',
        }
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        assert webhook.secrets.get('webhook_secret') == 'secret-123'
        assert webhook.secrets.get('api_key') == 'key-456'

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_initializes_sqs_client(self, mock_get_secret, mock_sqs):
        """Creates SQS client for queue operations."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        assert webhook._sqs == mock_sqs_client


class TestBaseWebhookNormalizeItem:
    """Tests for normalize_item() method."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_normalizes_item_to_common_schema(self, mock_get_secret, mock_sqs):
        """Converts webhook item to normalized schema."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        raw_item = {
            'id': 'webhook-123',
            'text': 'Webhook review text',
            'rating': 4,
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'https://example.com/review/123',
            'channel': 'review',
        }
        
        result = webhook.normalize_item(raw_item)
        
        assert result['id'] == 'webhook-123'
        assert result['source_platform'] == 'test_source'
        assert result['source_channel'] == 'review'
        assert result['text'] == 'Webhook review text'
        assert result['rating'] == 4
        assert result['is_webhook'] is True
        assert 'ingested_at' in result

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_defaults_channel_to_webhook(self, mock_get_secret, mock_sqs):
        """Uses 'webhook' as default channel."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        raw_item = {'id': '123', 'text': 'Test'}
        result = webhook.normalize_item(raw_item)
        
        assert result['source_channel'] == 'webhook'


class TestBaseWebhookSendToQueue:
    """Tests for send_to_queue() method."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_sends_items_to_sqs_in_batches(self, mock_get_secret, mock_sqs):
        """Sends items to SQS in batches of 10."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        items = [{'id': f'item-{i}', 'text': f'Text {i}'} for i in range(15)]
        webhook.send_to_queue(items)
        
        assert mock_sqs_client.send_message_batch.call_count == 2

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_does_nothing_for_empty_items(self, mock_get_secret, mock_sqs):
        """Does not call SQS when items list is empty."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        webhook.send_to_queue([])
        
        mock_sqs_client.send_message_batch.assert_not_called()


class TestBaseWebhookHandle:
    """Tests for handle() method."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_processes_webhook_and_returns_success(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Parses payload, normalizes items, and queues them."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return [
                    {'id': '1', 'text': 'Review 1', 'created_at': '2025-01-01T00:00:00Z'},
                    {'id': '2', 'text': 'Review 2', 'created_at': '2025-01-01T01:00:00Z'},
                ]
        
        webhook = TestWebhook()
        
        event = {
            'body': json.dumps({'eventType': 'review-created'}),
            'headers': {'Content-Type': 'application/json'},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = webhook.handle(event, None)
        
        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['status'] == 'ok'
        assert body['items_processed'] == 2
        mock_sqs_client.send_message_batch.assert_called()

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_returns_200_when_no_items_to_process(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Returns success with 0 items when payload has no items."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []  # No items
        
        webhook = TestWebhook()
        
        event = {
            'body': '{}',
            'headers': {},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = webhook.handle(event, None)
        
        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['items_processed'] == 0

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_returns_400_for_invalid_json(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Returns 400 when body is not valid JSON."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        event = {
            'body': 'not valid json {{{',
            'headers': {},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = webhook.handle(event, None)
        
        assert result['statusCode'] == 400
        assert 'Invalid JSON' in result['body']

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_returns_500_on_processing_error(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Returns 500 when processing fails."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                raise Exception('Processing failed')
        
        webhook = TestWebhook()
        
        event = {
            'body': '{}',
            'headers': {},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        result = webhook.handle(event, None)
        
        assert result['statusCode'] == 500
        assert 'Internal server error' in result['body']

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_handles_base64_encoded_body(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Decodes base64 body before processing."""
        import base64
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        parsed_body = None
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                nonlocal parsed_body
                parsed_body = body
                return [{'id': '1', 'text': 'Test'}]
        
        webhook = TestWebhook()
        
        original_body = json.dumps({'test': 'data'})
        encoded_body = base64.b64encode(original_body.encode()).decode()
        
        event = {
            'body': encoded_body,
            'headers': {},
            'isBase64Encoded': True,
            'requestContext': {'identity': {'sourceIp': '1.2.3.4'}},
        }
        
        webhook.handle(event, None)
        
        assert parsed_body == {'test': 'data'}

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    @patch('_shared.base_webhook.emit_audit_event')
    def test_emits_audit_event_on_success(
        self, mock_audit, mock_get_secret, mock_sqs
    ):
        """Emits webhook.received audit event."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return [{'id': '1', 'text': 'Test'}]
        
        webhook = TestWebhook()
        
        event = {
            'body': '{}',
            'headers': {},
            'isBase64Encoded': False,
            'requestContext': {'identity': {'sourceIp': '192.168.1.100'}},
        }
        
        webhook.handle(event, None)
        
        # Should have called audit at least twice (start and end)
        assert mock_audit.call_count >= 1


class TestBaseWebhookExtractClientIp:
    """Tests for _extract_client_ip() method."""

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_extracts_ip_from_request_context(self, mock_get_secret, mock_sqs):
        """Extracts source IP from API Gateway event."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        event = {
            'requestContext': {
                'identity': {'sourceIp': '203.0.113.50'}
            }
        }
        
        result = webhook._extract_client_ip(event)
        
        assert result == '203.0.113.50'

    @patch('_shared.base_webhook.get_sqs_client')
    @patch('_shared.base_webhook.get_secret')
    def test_returns_unknown_when_ip_not_present(self, mock_get_secret, mock_sqs):
        """Returns 'unknown' when IP not in event."""
        from _shared.base_webhook import BaseWebhook
        
        mock_get_secret.return_value = {}
        
        class TestWebhook(BaseWebhook):
            def parse_webhook_payload(self, body, headers):
                return []
        
        webhook = TestWebhook()
        
        event = {'requestContext': {}}
        
        result = webhook._extract_client_ip(event)
        
        assert result == 'unknown'
