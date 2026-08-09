"""Tests for base_ingestor.py - Base class for all ingestors."""
from unittest.mock import MagicMock, patch

import pytest


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
    def test_does_not_leak_other_known_plugin_secrets(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Keys prefixed for another KNOWN plugin must not leak into this plugin's secrets.

        Regression guard for per-plugin secret isolation: every plugin id must be
        listed in BaseIngestor._get_known_prefixes(). If a plugin (e.g. synthetic_reviews)
        is missing from that list, its `<plugin>_*` keys in the shared secret are treated
        as unprefixed shared/legacy keys and leak into every other plugin's loaded config.
        This test fails if a known plugin is dropped from the prefix list.
        """
        from _shared.base_ingestor import BaseIngestor

        mock_get_secret.return_value = {
            'test_source_api_key': 'mine',            # this plugin's own key
            'synthetic_reviews_api_key': 'not-mine',  # another known plugin's key
            'shared_legacy_key': 'shared',            # no known prefix -> shared/legacy
        }
        mock_dynamo.return_value.Table.return_value = MagicMock()

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []

        ingestor = TestIngestor()  # source_platform = 'test_source' (conftest env)

        # own key: present and prefix-stripped
        assert ingestor.secrets.get('api_key') == 'mine'
        # unprefixed key: kept as a shared/legacy value
        assert ingestor.secrets.get('shared_legacy_key') == 'shared'
        # another known plugin's key: excluded entirely, and never surfaced under any name
        assert 'synthetic_reviews_api_key' not in ingestor.secrets
        assert 'not-mine' not in ingestor.secrets.values()

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
        # Use a callable side_effect that derives Successful from the actual
        # Entries passed.  This is correct for any batch size and any number of
        # calls — an unexpected extra call (e.g. a retry round) raises
        # AttributeError rather than a confusing StopIteration, and the mock
        # never overclaims successes for a short final batch.
        def _batch_success(**kwargs):
            return {
                'Successful': [{'Id': e['Id']} for e in kwargs['Entries']],
                'Failed': [],
            }
        mock_sqs_client.send_message_batch.side_effect = _batch_success
        mock_sqs.return_value = mock_sqs_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []

        ingestor = TestIngestor()

        # Send 25 items - should result in 3 batches (10 + 10 + 5)
        items = [{'id': f'item-{i}', 'text': f'Text {i}'} for i in range(25)]
        with patch('_shared.sqs_utils.metrics') as mock_metrics:
            result = ingestor.send_to_queue(items)

        assert mock_sqs_client.send_message_batch.call_count == 3
        assert result == 25
        # Metric must reflect the actual confirmed count (25), not 30
        mock_metrics.add_metric.assert_called_once_with(
            name='ItemsIngested', unit='Count', value=25
        )

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
        with patch('_shared.sqs_utils.metrics'):
            ingestor.send_to_queue([])

        mock_sqs_client.send_message_batch.assert_not_called()

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_raises_when_sqs_reports_failed_entries(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """send_to_queue raises RuntimeError when SQS returns Failed entries.

        Reverts-to-catch: discarding the send_message_batch response (the
        original defect) means no exception is raised and the feedback is
        silently lost.  This test fails against the old code.
        """
        from _shared.base_ingestor import BaseIngestor

        mock_sqs_client = MagicMock()
        mock_sqs_client.send_message_batch.return_value = {
            'Successful': [],
            'Failed': [
                {
                    'Id': '0',
                    'SenderFault': True,
                    'Code': 'MessageTooLarge',
                    'Message': 'Message too large',
                }
            ],
        }
        mock_sqs.return_value = mock_sqs_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []

        ingestor = TestIngestor()
        items = [{'id': 'item-abc', 'text': 'Some feedback'}]

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            ingestor.send_to_queue(items)

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    def test_metric_uses_actual_enqueued_count(
        self, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """ItemsIngested metric equals the confirmed-enqueued count, not the
        attempted count.

        Reverts-to-catch: emitting len(items) regardless of the response was
        the original bug; this test would then see value=2 instead of value=1.
        """
        from _shared.base_ingestor import BaseIngestor

        mock_sqs_client = MagicMock()
        # 2 items submitted, 1 succeeds, 1 fails permanently
        mock_sqs_client.send_message_batch.return_value = {
            'Successful': [{'Id': '0'}],
            'Failed': [
                {
                    'Id': '1',
                    'SenderFault': True,
                    'Code': 'MessageTooLarge',
                    'Message': 'Too large',
                }
            ],
        }
        mock_sqs.return_value = mock_sqs_client
        mock_dynamo.return_value.Table.return_value = MagicMock()
        mock_get_secret.return_value = {}

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []

        ingestor = TestIngestor()
        items = [{'id': '0', 'text': 'ok'}, {'id': '1', 'text': 'x' * 300_000}]

        with patch('_shared.sqs_utils.metrics') as mock_metrics, pytest.raises(RuntimeError):
            ingestor.send_to_queue(items)

        mock_metrics.add_metric.assert_called_once_with(
            name='ItemsIngested', unit='Count', value=1
        )

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.emit_audit_event')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_propagates_sqs_failure(
        self, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """run() must raise (not return success) when send_to_queue fails.

        Reverts-to-catch: swallowing the RuntimeError from send_to_queue
        would return {"status": "success"} even though items were lost.
        """
        from _shared.base_ingestor import BaseIngestor

        mock_sqs_client = MagicMock()
        mock_sqs_client.send_message_batch.return_value = {
            'Successful': [],
            'Failed': [
                {
                    'Id': '0',
                    'SenderFault': True,
                    'Code': 'MessageTooLarge',
                    'Message': 'Too large',
                }
            ],
        }
        mock_sqs.return_value = mock_sqs_client
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield {'id': '1', 'text': 'Some feedback', 'created_at': '2025-01-01T00:00:00Z'}

        ingestor = TestIngestor()
        ingestor.circuit_breaker = MagicMock()
        ingestor.circuit_breaker.is_open.return_value = False

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            ingestor.run()


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
        # Return a proper SQS response so the helper can inspect Successful/Failed.
        mock_sqs_client.send_message_batch.return_value = {
            'Successful': [{'Id': '0'}, {'Id': '1'}],
            'Failed': [],
        }
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

        with patch('_shared.sqs_utils.metrics'):
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
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_items_processed_uses_confirmed_count(
        self, mock_audit, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """run() items_processed must equal the confirmed-enqueued count returned
        by send_to_queue, not len(items).

        Reverts-to-catch: if run() uses ``total_processed += len(items)`` instead
        of ``total_processed += self.send_to_queue(items)``, then even a partial
        failure that silently drops items would still report the full attempt count
        as success — exactly the bug this PR was opened to fix.

        This test fetches 3 items but the SQS mock confirms only 2; the expected
        items_processed is 2, not 3.
        """
        from _shared.base_ingestor import BaseIngestor

        mock_sqs_client = MagicMock()
        # 3 items sent, but SQS only confirms 2 Successful (no failures — this
        # is the "honest partial success" scenario, e.g. de-dup on the queue side).
        mock_sqs_client.send_message_batch.return_value = {
            'Successful': [{'Id': '0'}, {'Id': '1'}],
            'Failed': [],
        }
        mock_sqs.return_value = mock_sqs_client
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        mock_dynamo.return_value.Table.return_value = mock_table
        mock_get_secret.return_value = {}

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield {'id': '1', 'text': 'Review 1', 'created_at': '2025-01-01T00:00:00Z'}
                yield {'id': '2', 'text': 'Review 2', 'created_at': '2025-01-01T01:00:00Z'}
                yield {'id': '3', 'text': 'Review 3', 'created_at': '2025-01-01T02:00:00Z'}

        ingestor = TestIngestor()
        ingestor.circuit_breaker = MagicMock()
        ingestor.circuit_breaker.is_open.return_value = False

        with patch('_shared.sqs_utils.metrics'):
            result = ingestor.run()

        assert result['status'] == 'success'
        # Must reflect confirmed (2) not attempted (3)
        assert result['items_processed'] == 2

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
        assert result == '4f06ec9dc8d32cd7b2585b137a910cd5'

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


class TestManualRunSecretCacheClear:
    """Centralized Save-then-Run-now guard (issues #141/#215).

    get_secret is lru_cached without TTL and BaseIngestor reads the secret at
    init, so manual runs (execution_id present) must clear the shared cache
    BEFORE that read — otherwise a warm container serves the pre-save secret
    snapshot. Previously three per-plugin copies of this guard existed (and
    synthetic_reviews had none); it now lives here so every current and future
    manual-run ingestor gets it for free.
    """

    def _make_ingestor(self, execution_id=None):
        from _shared.base_ingestor import BaseIngestor

        class TestIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield from []

        return TestIngestor(execution_id=execution_id)

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.clear_secret_cache')
    def test_manual_run_clears_cache_before_reading_the_secret(
        self, mock_clear, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        """Order matters: clearing after the read would be a no-op — the
        stale snapshot would already be loaded."""
        call_order = []
        mock_clear.side_effect = lambda: call_order.append('clear')

        def record_get_secret(_arn):
            call_order.append('get_secret')
            return {}

        mock_get_secret.side_effect = record_get_secret
        mock_dynamo.return_value.Table.return_value = MagicMock()

        ingestor = self._make_ingestor(execution_id='exec-1')

        assert call_order == ['clear', 'get_secret']
        assert ingestor.execution_id == 'exec-1'

    @patch('_shared.base_ingestor.get_dynamodb_resource')
    @patch('_shared.base_ingestor.get_s3_client')
    @patch('_shared.base_ingestor.get_sqs_client')
    @patch('_shared.base_ingestor.get_secret')
    @patch('_shared.base_ingestor.clear_secret_cache')
    def test_scheduled_run_keeps_the_warm_cache(
        self, mock_clear, mock_get_secret, mock_sqs, mock_s3, mock_dynamo
    ):
        mock_get_secret.return_value = {}
        mock_dynamo.return_value.Table.return_value = MagicMock()

        ingestor = self._make_ingestor()

        mock_clear.assert_not_called()
        assert ingestor.execution_id is None
