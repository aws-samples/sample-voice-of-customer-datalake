"""Tests for base_ingestor.py - Base class for all ingestors.

Every test runs with the ``ingestor_aws`` fixture (conftest.py) standing in for
the DynamoDB/S3/SQS client factories and the secret read; tests configure or
assert on the doubles it yields.
"""
from unittest.mock import MagicMock, patch

import pytest

from _shared.test.ingestor_fixtures import (
    THREE_REVIEWS,
    breaker_mock,
    ingestor_yielding,
    with_mock_circuit_breaker,
)
from _shared.test.scoped_secret import scoped_secret
from _shared.test.sqs_response_fixtures import (
    echo_batch_success,
    permanent_failure_response,
)


class TestBaseIngestorInit:
    """Tests for BaseIngestor initialization."""

    def test_loads_secrets_from_secrets_manager(self, ingestor_aws):
        """Loads API credentials from Secrets Manager."""
        ingestor_aws.get_secret.return_value = {
            'test_source_api_key': 'key-123',
            'test_source_api_secret': 'secret-456',
        }

        ingestor = ingestor_yielding()

        # Secrets should be filtered by plugin prefix and prefix stripped
        assert ingestor.secrets.get('api_key') == 'key-123'
        assert ingestor.secrets.get('api_secret') == 'secret-456'

    def test_does_not_leak_another_plugins_or_an_unprefixed_secret(self, ingestor_aws):
        """Only this plugin's namespace is loaded — nothing else, however it is keyed.

        This used to depend on a hand-maintained plugin-id list inside
        BaseIngestor: a key carrying no *known* prefix was passed through as a
        shared/legacy value, so forgetting to add a plugin to that list made its
        `<plugin>_*` keys read as unprefixed and leak into every other plugin.
        The list is gone (issue #251); the prefix scan is now the whole rule, so
        an unknown plugin's keys are excluded because they are not ours — not
        because someone remembered to enumerate them.

        Reverts-to-catch: restoring the "no known prefix -> shared/legacy"
        branch makes `shared_legacy_key` appear, and makes
        `synthetic_reviews_api_key` appear too as soon as that id falls off the
        list.
        """
        ingestor_aws.get_secret.return_value = {
            'test_source_api_key': 'mine',            # this plugin's own key
            'synthetic_reviews_api_key': 'not-mine',  # another plugin's key
            'shared_legacy_key': 'shared',            # carries no plugin prefix
        }

        ingestor = ingestor_yielding()  # source_platform = 'test_source' (conftest env)

        # own key: present and prefix-stripped — and it is the ONLY thing loaded
        assert ingestor.secrets == {'api_key': 'mine'}
        # neither foreign value is reachable under any name
        assert 'not-mine' not in ingestor.secrets.values()
        assert 'shared' not in ingestor.secrets.values()

    @pytest.mark.usefixtures('ingestor_aws')
    def test_initializes_circuit_breaker(self):
        """Creates CircuitBreaker for the plugin."""
        ingestor = ingestor_yielding()

        assert ingestor.circuit_breaker is not None
        assert ingestor.circuit_breaker.plugin_id == 'test_source'


class TestBaseIngestorWatermarks:
    """Tests for watermark get/set methods."""

    def test_get_watermark_returns_stored_value(self, ingestor_aws):
        """Returns watermark value from DynamoDB."""
        ingestor_aws.table.get_item.return_value = {
            'Item': {'value': '2025-01-01T00:00:00Z'}
        }

        result = ingestor_yielding().get_watermark('last_timestamp')

        assert result == '2025-01-01T00:00:00Z'
        ingestor_aws.table.get_item.assert_called_once_with(
            Key={'source': 'test_source#last_timestamp'}
        )

    def test_get_watermark_returns_default_when_not_found(self, ingestor_aws):
        """Returns default value when watermark not in DynamoDB."""
        ingestor_aws.table.get_item.return_value = {}  # No Item

        result = ingestor_yielding().get_watermark('last_id', default='default-123')

        assert result == 'default-123'

    def test_set_watermark_stores_value_in_dynamodb(self, ingestor_aws):
        """Stores watermark value in DynamoDB."""
        ingestor_yielding().set_watermark('last_id', 'review-999')

        ingestor_aws.table.put_item.assert_called_once()
        item = ingestor_aws.table.put_item.call_args.kwargs['Item']
        assert item['source'] == 'test_source#last_id'
        assert item['value'] == 'review-999'
        assert 'updated_at' in item


class TestBaseIngestorNormalizeItem:
    """Tests for normalize_item() method."""

    @pytest.mark.usefixtures('ingestor_aws')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_normalizes_item_to_common_schema(self):
        """Converts raw item to normalized schema."""
        raw_item = {
            'id': 'review-123',
            'text': 'Great product!',
            'rating': 5,
            'created_at': '2025-01-01T12:00:00Z',
            'url': 'https://example.com/review/123',
            'channel': 'api',
        }

        result = ingestor_yielding().normalize_item(raw_item)

        assert result['id'] == 'review-123'
        assert result['source_platform'] == 'test_source'
        assert result['source_channel'] == 'api'
        assert result['text'] == 'Great product!'
        assert result['rating'] == 5
        assert result['brand_name'] == 'TestBrand'
        assert 'ingested_at' in result

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', 'test-bucket')
    def test_stores_raw_data_to_s3_when_configured(self, ingestor_aws):
        """Stores raw data to S3 and includes URI in normalized item."""
        raw_item = {
            'id': 'review-456',
            'text': 'Good service',
            'created_at': '2025-01-02T10:00:00Z',
        }

        result = ingestor_yielding().normalize_item(raw_item)

        ingestor_aws.s3.put_object.assert_called_once()
        assert result['s3_raw_uri'] is not None
        assert 's3://test-bucket/' in result['s3_raw_uri']


class TestBaseIngestorSendToQueue:
    """Tests for send_to_queue() method."""

    def test_sends_items_to_sqs_in_batches(self, ingestor_aws):
        """Sends items to SQS in batches of 10."""
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        ingestor = ingestor_yielding()

        # Send 25 items - should result in 3 batches (10 + 10 + 5)
        items = [{'id': f'item-{i}', 'text': f'Text {i}'} for i in range(25)]
        with patch('_shared.sqs_utils.metrics') as mock_metrics:
            result = ingestor.send_to_queue(items)

        assert ingestor_aws.sqs.send_message_batch.call_count == 3
        assert result == 25
        # Metric must reflect the actual confirmed count (25), not 30
        mock_metrics.add_metric.assert_called_once_with(
            name='ItemsIngested', unit='Count', value=25
        )

    def test_does_nothing_for_empty_items(self, ingestor_aws):
        """Does not call SQS when items list is empty."""
        ingestor = ingestor_yielding()
        with patch('_shared.sqs_utils.metrics'):
            ingestor.send_to_queue([])

        ingestor_aws.sqs.send_message_batch.assert_not_called()

    def test_raises_when_sqs_reports_failed_entries(self, ingestor_aws):
        """send_to_queue raises RuntimeError when SQS returns Failed entries.

        Reverts-to-catch: discarding the send_message_batch response (the
        original defect) means no exception is raised and the feedback is
        silently lost.  This test fails against the old code.
        """
        ingestor_aws.sqs.send_message_batch.return_value = (
            permanent_failure_response('0', 'Message too large')
        )
        ingestor = ingestor_yielding()
        items = [{'id': 'item-abc', 'text': 'Some feedback'}]

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            ingestor.send_to_queue(items)

    def test_metric_uses_actual_enqueued_count(self, ingestor_aws):
        """ItemsIngested metric equals the confirmed-enqueued count, not the
        attempted count.

        Reverts-to-catch: emitting len(items) regardless of the response was
        the original bug; this test would then see value=2 instead of value=1.
        """
        # 2 items submitted, 1 succeeds, 1 fails permanently
        ingestor_aws.sqs.send_message_batch.return_value = (
            permanent_failure_response('1', 'Too large', success_ids=('0',))
        )
        ingestor = ingestor_yielding()
        items = [{'id': '0', 'text': 'ok'}, {'id': '1', 'text': 'x' * 300_000}]

        with patch('_shared.sqs_utils.metrics') as mock_metrics, pytest.raises(RuntimeError):
            ingestor.send_to_queue(items)

        mock_metrics.add_metric.assert_called_once_with(
            name='ItemsIngested', unit='Count', value=1
        )

    @patch('_shared.base_ingestor.emit_audit_event', new=MagicMock())
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_propagates_sqs_failure(self, ingestor_aws):
        """run() must raise (not return success) when send_to_queue fails.

        Reverts-to-catch: swallowing the RuntimeError from send_to_queue
        would return {"status": "success"} even though items were lost.
        """
        ingestor_aws.sqs.send_message_batch.return_value = (
            permanent_failure_response('0', 'Too large')
        )
        ingestor_aws.table.get_item.return_value = {}
        ingestor = with_mock_circuit_breaker(ingestor_yielding([
            {'id': '1', 'text': 'Some feedback', 'created_at': '2025-01-01T00:00:00Z'},
        ]))

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            ingestor.run()


@patch('_shared.base_ingestor.emit_audit_event', new=MagicMock())
class TestBaseIngestorRun:
    """Tests for run() method."""

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_processes_items_and_returns_success(self, ingestor_aws):
        """Fetches, normalizes, and queues items successfully."""
        # Return a proper SQS response so the helper can inspect Successful/Failed.
        ingestor_aws.sqs.send_message_batch.return_value = {
            'Successful': [{'Id': '0'}, {'Id': '1'}],
            'Failed': [],
        }
        ingestor_aws.table.get_item.return_value = {}
        ingestor = with_mock_circuit_breaker(ingestor_yielding(THREE_REVIEWS[:2]))

        with patch('_shared.sqs_utils.metrics'):
            result = ingestor.run()

        assert result['status'] == 'success'
        assert result['items_processed'] == 2
        ingestor_aws.sqs.send_message_batch.assert_called()
        breaker_mock(ingestor).record_success.assert_called_once()

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_items_processed_uses_confirmed_count(self, ingestor_aws):
        """run() items_processed must equal the confirmed-enqueued count returned
        by send_to_queue, not len(items).

        Reverts-to-catch: if run() uses ``total_processed += len(items)`` instead
        of ``total_processed += self.send_to_queue(items)``, then even a partial
        failure that silently drops items would still report the full attempt count
        as success — exactly the bug this PR was opened to fix.

        send_to_queue is patched to return a value lower than the number of
        fetched items, which isolates the accumulator in run() without relying on
        an SQS response shape that cannot occur in production (SQS accounts for
        every submitted entry in either Successful or Failed).
        """
        ingestor_aws.table.get_item.return_value = {}
        ingestor = with_mock_circuit_breaker(ingestor_yielding(THREE_REVIEWS))

        with patch.object(type(ingestor), 'send_to_queue', return_value=2):
            result = ingestor.run()

        assert result['status'] == 'success'
        # Must reflect the count send_to_queue confirmed (2), not the 3 attempted
        assert result['items_processed'] == 2

    @pytest.mark.parametrize(
        'response',
        [
            # A genuinely partial failure: SQS accounts for all 3 entries, 2
            # confirmed and 1 explicitly failed with SenderFault=True so it is
            # never retried.
            #
            # Reverts-to-catch: if the Failed list is ignored (the original
            # defect), run() returns success, ``record_success()`` fires and the
            # watermark is advanced past the item that was never enqueued —
            # making the loss permanent because the next run never re-fetches it.
            pytest.param(
                permanent_failure_response(
                    '2', 'malformed', code='InvalidMessageContents',
                    success_ids=('0', '1'),
                ),
                id='partial_failure',
            ),
            # 3 entries submitted, only 2 accounted for — one vanished.
            #
            # Reverts-to-catch: without the Successful+Failed reconciliation in
            # ``send_messages_to_queue``, run() returns ``{'status': 'success',
            # 'items_processed': 2}``, ``record_success()`` fires and the
            # watermark advances to '3' — the unaccounted item is lost
            # permanently.
            pytest.param(
                {'Successful': [{'Id': '0'}, {'Id': '1'}], 'Failed': []},
                id='unaccounted_entry',
            ),
            # Entry 2 is claimed in BOTH lists, with SenderFault=true so it is a
            # permanent failure rather than something a retry could resolve.
            #
            # Reverts-to-catch: trusting the Successful side and discarding the
            # Failed entry makes run() return ``{'status': 'success',
            # 'items_processed': 3}``, fire ``record_success()`` and advance the
            # watermark past feedback SQS explicitly reported as failed — so the
            # item is never re-fetched and the loss is permanent.  This is the
            # caller-level consequence that decides the direction; inside the
            # helper the choice looks like bookkeeping.
            pytest.param(
                permanent_failure_response(
                    '2', 'malformed', code='InvalidMessageContents',
                    success_ids=('0', '1', '2'),
                ),
                id='contradictory_response',
            ),
        ],
    )
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_raises_and_does_not_advance_watermark(self, ingestor_aws, response):
        """A send whose response does not confirm every fetched item must
        propagate RuntimeError out of run(), leaving the watermark unadvanced
        and the circuit breaker's success unrecorded (one case per way a
        response can fail to confirm an item; see the parameter comments)."""
        ingestor_aws.sqs.send_message_batch.return_value = response
        ingestor_aws.table.get_item.return_value = {}
        ingestor = with_mock_circuit_breaker(ingestor_yielding(THREE_REVIEWS))
        ingestor.set_watermark = MagicMock()

        with patch('_shared.sqs_utils.metrics'), pytest.raises(RuntimeError):
            ingestor.run()

        # The watermark must NOT be advanced past an item that never reached SQS
        ingestor.set_watermark.assert_not_called()
        breaker_mock(ingestor).record_success.assert_not_called()

    @patch('_shared.base_ingestor.AGGREGATES_TABLE', 'voc-aggregates-test')
    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_run_records_error_status_with_the_confirmed_count_when_enqueue_raises(
        self, ingestor_aws
    ):
        """When the enqueue raises, the SOURCE_RUN record must be written as
        'error' carrying the count confirmed *before* the failure.

        Nothing else in this suite asserts the error-path status write, so a
        change that skipped it — or that let the exception escape before it —
        would leave a manual run displaying 'running' for ever.

        Reverts-to-catch: reporting ``len(items)`` instead of the value
        ``send_to_queue`` returned writes 150 for a run in which only 100 items
        reached the queue, which is the attempted-vs-confirmed conflation this PR
        exists to remove, one level up from the helper.

        Known limitation, deliberately not tested here: ``items_found`` on this
        path is a *lower* bound.  Batches confirmed inside the raising
        ``send_to_queue`` call are counted by the ``ItemsIngested`` metric but not
        by run()'s accumulator, which only advances when that call returns.  The
        metric is the authoritative count of what landed; the watermark is not
        advanced either way, so nothing is lost by the under-report.
        """
        ingestor_aws.table.get_item.return_value = {}
        reviews = [
            {'id': str(i), 'text': f'Review {i}', 'created_at': '2025-01-01T00:00:00Z'}
            for i in range(150)
        ]
        ingestor = with_mock_circuit_breaker(
            ingestor_yielding(reviews, execution_id='exec-1')
        )
        ingestor.set_watermark = MagicMock()
        # First batch of 100 is confirmed; the trailing 50 are rejected.
        ingestor.send_to_queue = MagicMock(
            side_effect=[100, RuntimeError('50 ingestor item(s) could not be enqueued')]
        )

        with pytest.raises(RuntimeError):
            ingestor.run()

        error_writes = [
            call.kwargs['ExpressionAttributeValues']
            for call in ingestor_aws.table.update_item.call_args_list
            if call.kwargs.get('ExpressionAttributeValues', {}).get(':status') == 'error'
        ]
        assert len(error_writes) == 1, (
            f'Expected exactly one error status write, got {len(error_writes)}'
        )
        assert error_writes[0][':items_found'] == 100
        assert error_writes[0][':errors'] == ['RuntimeError']
        ingestor.set_watermark.assert_not_called()

    @patch('_shared.base_ingestor.AGGREGATES_TABLE', 'voc-aggregates-test')
    def test_run_status_stores_the_exception_type_not_its_text(self, ingestor_aws):
        """The SOURCE_RUN# row is readable by every user, so the raw exception text
        (here an upstream URL with a token) must not be written to it (#263)."""
        from _shared.base_ingestor import BaseIngestor

        class UpstreamFetchError(Exception):
            """A data-source failure whose message carries a credential."""

        class LeakyIngestor(BaseIngestor):
            def fetch_new_items(self):
                raise UpstreamFetchError('GET https://api.example/v1?token=SECRET-123 failed')

        ingestor = with_mock_circuit_breaker(LeakyIngestor(execution_id='exec-1'))
        with pytest.raises(UpstreamFetchError):
            ingestor.run()

        written = ingestor_aws.table.update_item.call_args.kwargs['ExpressionAttributeValues']
        assert written[':status'] == 'error'
        assert written[':errors'] == ['UpstreamFetchError']
        assert 'SECRET-123' not in repr(ingestor_aws.table.update_item.call_args_list)


class TestManualRunSecretCacheClear:
    """Centralized Save-then-Run-now guard (issues #141/#215).

    get_secret is lru_cached without TTL and BaseIngestor reads the secret at
    init, so manual runs (execution_id present) must clear the shared cache
    BEFORE that read — otherwise a warm container serves the pre-save secret
    snapshot. Previously three per-plugin copies of this guard existed (and
    synthetic_reviews had none); it now lives here so every current and future
    manual-run ingestor gets it for free.
    """

    @patch('_shared.base_ingestor.clear_secret_cache')
    def test_manual_run_clears_cache_before_reading_the_secret(
        self, mock_clear, ingestor_aws
    ):
        """Order matters: clearing after the read would be a no-op — the
        stale snapshot would already be loaded."""
        call_order = []
        mock_clear.side_effect = lambda: call_order.append('clear')

        def record_get_secret(_arn):
            call_order.append('get_secret')
            return scoped_secret()

        ingestor_aws.get_secret.side_effect = record_get_secret

        ingestor = ingestor_yielding(execution_id='exec-1')

        assert call_order == ['clear', 'get_secret']
        assert ingestor.execution_id == 'exec-1'

    @pytest.mark.usefixtures('ingestor_aws')
    @patch('_shared.base_ingestor.clear_secret_cache')
    def test_scheduled_run_keeps_the_warm_cache(self, mock_clear):
        ingestor = ingestor_yielding(execution_id=None)

        mock_clear.assert_not_called()
        assert ingestor.execution_id is None
