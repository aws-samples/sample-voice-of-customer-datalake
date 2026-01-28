"""Tests for base_ingestor.py - Base class for all ingestors."""
import os
import json
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone


class TestBaseIngestorInit:
    """Tests for BaseIngestor initialization."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_loads_secrets_from_secrets_manager(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Loads API credentials from Secrets Manager."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_get_secret.return_value = {
            'test_source_api_key': 'key-123',
            'test_source_api_secret': 'secret-456',
        }
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        # Secrets should be filtered by plugin prefix and prefix stripped
        assert ingestor.secrets.get('api_key') == 'key-123'
        assert ingestor.secrets.get('api_secret') == 'secret-456'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_initializes_circuit_breaker(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Creates CircuitBreaker for the plugin."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_get_secret.return_value = {}
        mock_dynamo.return_value.Table.return_value = MagicMock()
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        assert ingestor.circuit_breaker is not None
        assert ingestor.circuit_breaker.plugin_id == 'test_source'


class TestBaseIngestorWatermarks:
    """Tests for watermark get/set methods."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_get_watermark_returns_stored_value(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Returns watermark value from DynamoDB."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            'Item': {'value': '2025-01-01T00:00:00Z'}
        }
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        result = ingestor.get_watermark('last_timestamp')
        
        assert result == '2025-01-01T00:00:00Z'
        mock_table.get_item.assert_called_once_with(
            Key={'source': 'test_source#last_timestamp'}
        )

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_get_watermark_returns_default_when_not_found(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Returns default value when watermark not in DynamoDB."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}  # No Item
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        result = ingestor.get_watermark('last_id', default='default-123')
        
        assert result == 'default-123'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_set_watermark_stores_value_in_dynamodb(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Stores watermark value in DynamoDB."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_table = MagicMock()
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        ingestor.set_watermark('last_id', 'review-999')
        
        mock_table.put_item.assert_called_once()
        call_args = mock_table.put_item.call_args
        item = call_args.kwargs['Item']
        assert item['source'] == 'test_source#last_id'
        assert item['value'] == 'review-999'
        assert 'updated_at' in item


class TestBaseIngestorNormalizeItem:
    """Tests for normalize_item() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_normalizes_item_to_common_schema(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Converts raw item to normalized schema."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        raw_item = {
            'id': 'review-123',
            'text': 'Great product!',
            'rating': 5,
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'https://example.com/review/123',
            'channel': 'api',
        }
        
        result = ingestor.normalize_item(raw_item)
        
        assert result['id'] == 'review-123'
        assert result['source_platform'] == 'test_source'
        assert result['source_channel'] == 'api'
        assert result['text'] == 'Great product!'
        assert result['rating'] == 5
        assert result['brand_name'] == 'TestBrand'
        assert 'ingested_at' in result

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', 'test-bucket')
    def test_stores_raw_data_to_s3_when_configured(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Stores raw data to S3 and includes URI in normalized item."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_s3_client = MagicMock()
        mock_s3.return_value = mock_s3_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        raw_item = {
            'id': 'review-456',
            'text': 'Good service',
            'created_at': '2025-01-02T10:00:00Z',
        }
        
        result = ingestor.normalize_item(raw_item)
        
        mock_s3_client.put_object.assert_called_once()
        assert result['s3_raw_uri'] is not None
        assert 's3://test-bucket/' in result['s3_raw_uri']


class TestBaseIngestorSendToQueue:
    """Tests for send_to_queue() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_sends_items_to_sqs_in_batches(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Sends items to SQS in batches of 10."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        # Send 25 items - should result in 3 batches
        items = [{'id': f'item-{i}', 'text': f'Text {i}'} for i in range(25)]
        ingestor.send_to_queue(items)
        
        assert mock_sqs_client.send_message_batch.call_count == 3

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_does_nothing_for_empty_items(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Does not call SQS when items list is empty."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        ingestor.send_to_queue([])
        
        mock_sqs_client.send_message_batch.assert_not_called()


class TestBaseIngestorRun:
    """Tests for run() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.emit_audit_event')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_processes_items_and_returns_success(
        self, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Fetches, normalizes, and queues items successfully."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_sqs_client = MagicMock()
        mock_sqs.return_value = mock_sqs_client
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield {'id': '1', 'text': 'Review 1', 'created_at': '2025-01-01T00:00:00Z'}
                yield {'id': '2', 'text': 'Review 2', 'created_at': '2025-01-01T01:00:00Z'}
        
        ingestor = TestIngestor()
        
        # Mock circuit breaker
        ingestor.circuit_breaker = MagicMock()
        ingestor.circuit_breaker.is_open.return_value = False
        
        result = ingestor.run()
        
        assert result['status'] == 'success'
        assert result['items_processed'] == 2
        mock_sqs_client.send_message_batch.assert_called()
        ingestor.circuit_breaker.record_success.assert_called_once()

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.emit_audit_event')
    def test_skips_when_circuit_breaker_open(
        self, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Returns skipped status when circuit breaker is open."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield {'id': '1', 'text': 'Should not process'}
        
        ingestor = TestIngestor()
        ingestor.circuit_breaker = MagicMock()
        ingestor.circuit_breaker.is_open.return_value = True
        
        result = ingestor.run()
        
        assert result['status'] == 'skipped'
        assert result['reason'] == 'circuit_breaker_open'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.emit_audit_event')
    def test_records_failure_on_exception(
        self, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Records failure in circuit breaker when exception occurs."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                raise Exception('API connection failed')
        
        ingestor = TestIngestor()
        ingestor.circuit_breaker = MagicMock()
        ingestor.circuit_breaker.is_open.return_value = False
        
        with pytest.raises(Exception, match='API connection failed'):
            ingestor.run()
        
        ingestor.circuit_breaker.record_failure.assert_called_once()


class TestBaseIngestorGenerateDeterministicId:
    """Tests for _generate_deterministic_id() method."""

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_uses_source_id_when_available(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Uses item's id field for deterministic ID."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        item = {'id': 'review-abc-123'}
        result = ingestor._generate_deterministic_id(item)
        
        # Hyphens are allowed, only special chars like @ are sanitized
        assert 'review-abc-123' == result

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_generates_hash_when_no_id(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Generates hash from content when no id field."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        item = {
            'text': 'Some review text',
            'created_at': '2025-01-01T00:00:00Z',
            'url': 'https://example.com/review',
        }
        result = ingestor._generate_deterministic_id(item)
        
        # Should generate deterministic SHA-256 hash (32 hex chars)
        assert result == '6f8bcf85bf9acfa69ffa24b8754a38c1'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_same_content_produces_same_id(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Same content always produces same deterministic ID."""
        from _shared.base_ingestor import BaseIngestor
        
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}
        
        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []
        
        ingestor = TestIngestor()
        
        item = {
            'text': 'Consistent text',
            'created_at': '2025-01-01T00:00:00Z',
            'url': 'https://example.com',
        }
        
        id1 = ingestor._generate_deterministic_id(item)
        id2 = ingestor._generate_deterministic_id(item)
        
        assert id1 == id2
