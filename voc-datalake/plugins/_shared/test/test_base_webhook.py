"""Tests for base_webhook.py - Base class for webhook handlers.

Every test runs with the ``webhook_aws`` fixture (conftest.py) standing in for
the SQS client factory and the secret read.
"""
import json
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.sqs_response_fixtures import (
    echo_batch_success,
    permanent_failure_response,
)
from _shared.test.webhook_fixtures import webhook_event, webhook_parsing


class TestBaseWebhookInit:
    """Tests for BaseWebhook initialization."""

    def test_loads_secrets_with_plugin_prefix_filtering(self, webhook_aws):
        """Loads and filters secrets by plugin prefix."""
        webhook_aws.get_secret.return_value = {
            'test_source_webhook_secret': 'secret-123',
            'test_source_api_key': 'key-456',
            'other_plugin_key': 'should-not-include',
        }

        webhook = webhook_parsing()

        assert webhook.secrets.get('webhook_secret') == 'secret-123'
        assert webhook.secrets.get('api_key') == 'key-456'
        # Equality, not two .get()s: an assertion pair cannot notice a THIRD
        # key arriving, which is how the foreign 'other_plugin_key' used to
        # slip through (issue #251).
        assert webhook.secrets == {'webhook_secret': 'secret-123', 'api_key': 'key-456'}


@pytest.mark.usefixtures('webhook_aws')
class TestBaseWebhookNormalizeItem:
    """Tests for normalize_item() method."""

    def test_normalizes_item_to_common_schema(self):
        """Converts webhook item to normalized schema."""
        raw_item = {
            'id': 'webhook-123',
            'text': 'Webhook review text',
            'rating': 4,
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'https://example.com/review/123',
            'channel': 'review',
        }

        result = webhook_parsing().normalize_item(raw_item)

        assert result['id'] == 'webhook-123'
        assert result['source_platform'] == 'test_source'
        assert result['source_channel'] == 'review'
        assert result['text'] == 'Webhook review text'
        assert result['rating'] == 4
        assert result['is_webhook'] is True
        assert 'ingested_at' in result

    def test_defaults_channel_to_webhook(self):
        """Uses 'webhook' as default channel."""
        result = webhook_parsing().normalize_item({'id': '123', 'text': 'Test'})

        assert result['source_channel'] == 'webhook'


class TestBaseWebhookSendToQueue:
    """Tests for send_to_queue() method."""

    def test_sends_items_to_sqs_in_batches(self, webhook_aws):
        """Sends items to SQS in batches of 10."""
        webhook_aws.sqs.send_message_batch.side_effect = echo_batch_success
        webhook = webhook_parsing()

        items = [{'id': f'item-{i}', 'text': f'Text {i}'} for i in range(15)]
        with patch('_shared.sqs_utils.metrics') as mock_metrics:
            result = webhook.send_to_queue(items)

        assert webhook_aws.sqs.send_message_batch.call_count == 2
        assert result == 15
        # Metric must reflect the actual confirmed count (15), not 20
        mock_metrics.add_metric.assert_called_once_with(
            name='WebhookItemsIngested', unit='Count', value=15
        )

    def test_does_nothing_for_empty_items(self, webhook_aws):
        """Does not call SQS when items list is empty."""
        webhook = webhook_parsing()
        with patch('_shared.sqs_utils.metrics'):
            webhook.send_to_queue([])

        webhook_aws.sqs.send_message_batch.assert_not_called()

    def test_raises_when_sqs_reports_failed_entries(self, webhook_aws):
        """send_to_queue raises RuntimeError when SQS returns Failed entries.

        Reverts-to-catch: discarding the send_message_batch response (the
        original defect) means no exception is raised and feedback is lost.
        This test fails against the old code.
        """
        webhook_aws.sqs.send_message_batch.return_value = (
            permanent_failure_response('0', 'Message too large')
        )
        webhook = webhook_parsing()
        items = [{'id': 'wh-item', 'text': 'Webhook feedback'}]

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            webhook.send_to_queue(items)

    def test_metric_uses_actual_enqueued_count(self, webhook_aws):
        """WebhookItemsIngested metric equals the confirmed-enqueued count, not
        the attempted count.

        Reverts-to-catch: emitting len(items) regardless of the response was
        the original bug; this test would then see value=2 instead of value=1.
        """
        webhook_aws.sqs.send_message_batch.return_value = (
            permanent_failure_response('1', 'Too large', success_ids=('0',))
        )
        webhook = webhook_parsing()
        items = [{'id': '0', 'text': 'ok'}, {'id': '1', 'text': 'x' * 300_000}]

        with patch('_shared.sqs_utils.metrics') as mock_metrics, pytest.raises(RuntimeError):
            webhook.send_to_queue(items)

        mock_metrics.add_metric.assert_called_once_with(
            name='WebhookItemsIngested', unit='Count', value=1
        )


class TestBaseWebhookHandle:
    """Tests for handle() method."""

    @patch('_shared.base_webhook.emit_audit_event', new=MagicMock())
    def test_processes_webhook_and_returns_success(self, webhook_aws):
        """Parses payload, normalizes items, and queues them."""
        webhook_aws.sqs.send_message_batch.return_value = {
            'Successful': [{'Id': '0'}, {'Id': '1'}],
            'Failed': [],
        }
        webhook = webhook_parsing([
            {'id': '1', 'text': 'Review 1', 'created_at': '2025-01-01T00:00:00Z'},
            {'id': '2', 'text': 'Review 2', 'created_at': '2025-01-01T01:00:00Z'},
        ])
        event = webhook_event(
            body=json.dumps({'eventType': 'review-created'}),
            headers={'Content-Type': 'application/json'},
        )

        with patch('_shared.sqs_utils.metrics'):
            result = webhook.handle(event, None)

        assert result['statusCode'] == 200
        body = json.loads(result['body'])
        assert body['status'] == 'ok'
        assert body['items_processed'] == 2
        assert webhook_aws.sqs.send_message_batch.call_count == 1
