"""Tests for base_ingestor.py - Base class for all ingestors.

Every test runs with the ``ingestor_aws`` fixture (conftest.py) standing in for
the DynamoDB/S3/SQS client factories and the secret read; tests configure or
assert on the doubles it yields.
"""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

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
from _shared.test.workspace_fixtures import OTHER_SCOPE, OTHER_WS, REFUSED, SCHEDULED_TICK, SCOPE, SECRET_NAME, WS


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
            Key={'source': f'WS#{WS}#test_source#last_timestamp'}
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
        assert item['source'] == f'WS#{WS}#test_source#last_id'
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

        ingestor = with_mock_circuit_breaker(LeakyIngestor(SCOPE, execution_id='exec-1'))
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


def _sent_messages(sqs: MagicMock) -> list[dict]:
    return [json.loads(entry['MessageBody'])
            for call in sqs.send_message_batch.call_args_list for entry in call.kwargs['Entries']]


class TestTheRunsWorkspaceComesFromItsEvent:
    """docs/multi-workspace.md, phase 2 "ingestion": the event names the workspace (``run_in_workspace``)."""

    def test_an_event_naming_a_workspace_runs_in_that_scope(self):
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock(return_value={'status': 'success'})

        assert run_in_workspace({'workspace_id': WS, 'execution_id': 'exec-1'}, run) == {'status': 'success'}
        run.assert_called_once_with(SCOPE)

    @pytest.mark.parametrize('event', [
        {'workspace_id': ''}, {'workspace_id': 'ws_nope'}, {'workspace_id': f' {WS}'}, {'workspace_id': 7},
        {'workspace_id': None}, {'workspace_id': WS.lower(), 'execution_id': 'exec-1'},
        # A tick shape that also names a workspace is a workspace's run, so a malformed id is still refused.
        {**SCHEDULED_TICK, 'workspace_id': 'not-a-workspace'},
    ])
    def test_a_malformed_workspace_is_refused_and_never_run_deployment_wide(self, event):
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock()
        with patch('_shared.base_ingestor.metrics') as metrics, \
                patch('_shared.base_ingestor.fan_out_once') as fan_out:
            result = run_in_workspace(event, run)

        assert result == REFUSED
        run.assert_not_called()
        fan_out.assert_not_called()
        metrics.add_metric.assert_called_once_with(name='IngestorEventRefused', unit='Count', value=1)

    @pytest.mark.parametrize('event', [{}, {'execution_id': 'exec-1'}, {'Records': []}, None, [], 'ws'])
    def test_an_event_naming_no_workspace_runs_deployment_wide_as_before(self, event):
        """The API's Run now, scraper run and reprocess and an S3 upload send no workspace_id: they keep the
        deployment-wide path until phase 2's last slice moves them."""
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock(return_value={'status': 'success'})
        with patch('_shared.base_ingestor.fan_out_once') as fan_out:
            assert run_in_workspace(event, run) == {'status': 'success'}

        run.assert_called_once_with(None)
        fan_out.assert_not_called()

    def test_the_scheduled_tick_fans_out_first_then_runs_deployment_wide(self):
        """The fan-out comes first, so a deployment-wide run that raises or times out never keeps the
        workspaces from their tick."""
        from _shared.base_ingestor import run_in_workspace

        order = MagicMock()
        order.run.return_value = {'status': 'success', 'items_processed': 3}
        with patch('_shared.base_ingestor.fan_out_once', order.fan_out_once):
            assert run_in_workspace(dict(SCHEDULED_TICK), order.run) == {'status': 'success', 'items_processed': 3}

        assert order.mock_calls == [call.fan_out_once('test_source', SCHEDULED_TICK), call.run(None)]

    def test_a_failing_deployment_run_on_a_tick_has_fanned_out_and_raises_as_before(self):
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock(side_effect=RuntimeError('source down'))
        with patch('_shared.base_ingestor.fan_out_once') as fan_out, pytest.raises(RuntimeError, match='source down'):
            run_in_workspace(dict(SCHEDULED_TICK), run)

        fan_out.assert_called_once_with('test_source', SCHEDULED_TICK)

    def test_only_an_eventbridge_scheduled_event_is_a_tick(self):
        from _shared.base_ingestor import is_scheduled_tick

        assert is_scheduled_tick(dict(SCHEDULED_TICK))
        assert not is_scheduled_tick({**SCHEDULED_TICK, 'workspace_id': WS})
        assert not is_scheduled_tick({**SCHEDULED_TICK, 'source': 'aws.s3'})
        assert not is_scheduled_tick({**SCHEDULED_TICK, 'detail-type': 'Object Created'})
        assert not is_scheduled_tick({})
        assert not is_scheduled_tick(None)


class TestTheScheduledTickFansOut:
    """One async invoke of this function per workspace ``workspaces_with_plugin`` names, with its id only."""

    @pytest.fixture
    def tick(self, monkeypatch):
        monkeypatch.setenv('AWS_LAMBDA_FUNCTION_NAME', 'voc-ingestor-test_source')
        monkeypatch.setattr('_shared.base_ingestor.WORKSPACES_TABLE', 'test-workspaces')
        with patch('_shared.base_ingestor.get_dynamodb_resource') as dynamo, \
                patch('_shared.base_ingestor.workspaces_with_plugin', return_value=[WS, OTHER_WS]) as listed, \
                patch('_shared.self_invoke.invoke_lambda_async', return_value={'StatusCode': 202}) as invoke:
            yield SimpleNamespace(dynamo=dynamo, listed=listed, invoke=invoke)

    def test_each_workspace_with_the_plugin_gets_exactly_one_run_naming_it(self, tick):
        from _shared.base_ingestor import fan_out_tick

        result = fan_out_tick('test_source')

        tick.dynamo.return_value.Table.assert_called_once_with('test-workspaces')
        tick.listed.assert_called_once_with(tick.dynamo.return_value.Table.return_value, 'test_source')
        assert tick.invoke.call_args_list == [
            call('voc-ingestor-test_source', {'workspace_id': WS}),
            call('voc-ingestor-test_source', {'workspace_id': OTHER_WS}),
        ]
        assert result == {'status': 'fanned_out', 'workspaces': 2, 'failed': 0}

    def test_no_workspace_with_the_plugin_invokes_nothing(self, tick):
        from _shared.base_ingestor import fan_out_tick

        tick.listed.return_value = []

        assert fan_out_tick('test_source') == {'status': 'fanned_out', 'workspaces': 0, 'failed': 0}
        tick.invoke.assert_not_called()

    @pytest.mark.parametrize('failure', [
        ClientError({'Error': {'Code': 'TooManyRequestsException'}}, 'Invoke'), {'StatusCode': 500},
    ])
    def test_a_failed_invoke_is_counted_and_the_other_workspaces_still_run(self, tick, failure):
        from _shared.base_ingestor import fan_out_tick

        tick.invoke.side_effect = [failure, {'StatusCode': 202}]
        with patch('_shared.base_ingestor.metrics') as metrics:
            result = fan_out_tick('test_source')

        assert tick.invoke.call_count == 2
        assert result == {'status': 'fanned_out', 'workspaces': 1, 'failed': 1}
        metrics.add_metric.assert_called_once_with(name='IngestFanOutFailures', unit='Count', value=1)

    def test_a_list_that_cannot_be_read_raises(self, tick):
        from _shared.base_ingestor import fan_out_tick

        tick.listed.side_effect = ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'Query')

        with pytest.raises(ClientError):
            fan_out_tick('test_source')
        tick.invoke.assert_not_called()

    def test_a_tick_without_the_workspaces_table_refuses_to_guess(self, tick, monkeypatch):
        from _shared.base_ingestor import fan_out_tick
        from shared.exceptions import ConfigurationError

        monkeypatch.setattr('_shared.base_ingestor.WORKSPACES_TABLE', '')

        with pytest.raises(ConfigurationError):
            fan_out_tick('test_source')
        tick.invoke.assert_not_called()

    def test_without_its_function_name_every_workspaces_invoke_counts_as_failed(self, tick, monkeypatch):
        from _shared.base_ingestor import fan_out_tick

        monkeypatch.delenv('AWS_LAMBDA_FUNCTION_NAME')

        assert fan_out_tick('test_source') == {'status': 'fanned_out', 'workspaces': 0, 'failed': 2}
        tick.invoke.assert_not_called()


def _cancelled(*codes: str) -> ClientError:
    return ClientError({'Error': {'Code': 'TransactionCanceledException'},
                        'CancellationReasons': [{'Code': code} for code in codes]}, 'TransactWriteItems')


class _ClaimTable:
    """voc-idempotency under a one-claim transaction (``attribute_not_exists(id)``, the only condition a claim
    sends): a second claim of a key is cancelled as DynamoDB cancels it (moto cannot run here: plugins/conftest.py
    refuses every call)."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.transact_write_items = MagicMock(side_effect=self._transact)

    def _transact(self, *, TransactItems):
        assert len(TransactItems) == 1
        put = TransactItems[0]['Put']
        assert (put['TableName'], put['ConditionExpression']) == ('test-idempotency', 'attribute_not_exists(id)')
        if put['Item']['id'] in self.items:
            raise _cancelled('ConditionalCheckFailed')
        self.items[put['Item']['id']] = put['Item']


class TestTheTickFansOutAtMostOnce:
    """``fan_out_once``: a claim of the tick's EventBridge event id in voc-idempotency, so Lambda's retries of a
    tick whose deployment-wide run raised never start the workspaces' runs twice."""

    @pytest.fixture
    def claims(self, monkeypatch):
        monkeypatch.setattr('_shared.base_ingestor.IDEMPOTENCY_TABLE', 'test-idempotency')
        table = _ClaimTable()
        with patch('_shared.base_ingestor.get_dynamodb_resource') as resource, \
                patch('_shared.base_ingestor.fan_out_tick') as fan_out, \
                patch('_shared.base_ingestor.metrics') as metrics:
            resource.return_value.meta.client = table
            yield SimpleNamespace(table=table, fan_out=fan_out, metrics=metrics)

    def test_a_retry_of_a_tick_whose_run_raised_fans_out_no_second_time(self, claims):
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock(side_effect=RuntimeError('source down'))
        for _ in range(2):  # the delivery, then Lambda's asynchronous retry of the same event
            with pytest.raises(RuntimeError, match='source down'):
                run_in_workspace(dict(SCHEDULED_TICK), run)

        claims.fan_out.assert_called_once_with('test_source')
        assert run.call_args_list == [call(None), call(None)]
        claims.metrics.add_metric.assert_not_called()

    def test_the_claim_is_the_ticks_event_id_with_the_normal_expiry(self, claims):
        from _shared.base_ingestor import fan_out_once
        from shared.idempotency import DEDUPE_CLAIM_TTL_SECONDS

        with patch('_shared.base_ingestor.datetime') as clock:
            clock.now.return_value.timestamp.return_value = 1_000_000.0
            fan_out_once('test_source', dict(SCHEDULED_TICK))

        assert claims.table.items == {'ingestor#fanout#test_source#tick-1': {
            'id': 'ingestor#fanout#test_source#tick-1', 'expiration': 1_000_000 + DEDUPE_CLAIM_TTL_SECONDS}}

    def test_a_new_tick_fans_out_again(self, claims):
        from _shared.base_ingestor import fan_out_once

        fan_out_once('test_source', dict(SCHEDULED_TICK))
        fan_out_once('test_source', {**SCHEDULED_TICK, 'id': 'tick-2'})
        fan_out_once('other_source', dict(SCHEDULED_TICK))

        assert claims.fan_out.call_args_list == [call('test_source'), call('test_source'), call('other_source')]

    def test_a_failing_fan_out_is_metered_and_never_changes_the_deployment_runs_outcome(self, claims):
        from _shared.base_ingestor import run_in_workspace

        claims.fan_out.side_effect = ClientError({'Error': {'Code': 'X'}}, 'Query')
        run = MagicMock(return_value={'status': 'success'})

        assert run_in_workspace(dict(SCHEDULED_TICK), run) == {'status': 'success'}
        run.assert_called_once_with(None)
        claims.metrics.add_metric.assert_called_once_with(name='IngestFanOutFailures', unit='Count', value=1)

    @pytest.mark.parametrize('tick', [
        {**SCHEDULED_TICK, 'id': ''}, {key: value for key, value in SCHEDULED_TICK.items() if key != 'id'},
    ])
    def test_a_tick_without_an_event_id_fans_out_nothing_and_still_runs(self, claims, tick):
        from _shared.base_ingestor import run_in_workspace

        run = MagicMock(return_value={'status': 'success'})

        assert run_in_workspace(tick, run) == {'status': 'success'}
        claims.fan_out.assert_not_called()
        claims.metrics.add_metric.assert_called_once_with(name='IngestFanOutFailures', unit='Count', value=1)

    def test_without_the_idempotency_table_it_fans_out_nothing(self, claims, monkeypatch):
        from _shared.base_ingestor import fan_out_once

        monkeypatch.setattr('_shared.base_ingestor.IDEMPOTENCY_TABLE', '')
        fan_out_once('test_source', dict(SCHEDULED_TICK))

        claims.fan_out.assert_not_called()
        claims.metrics.add_metric.assert_called_once_with(name='IngestFanOutFailures', unit='Count', value=1)

    @pytest.mark.parametrize('failure', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException'}}, 'TransactWriteItems'),
        _cancelled('TransactionConflict'), _cancelled('ThrottlingError'), _cancelled(),
    ], ids=['throttled', 'conflict', 'throttled-in-transaction', 'no-reasons'])
    def test_a_claim_that_is_not_made_fans_out_nothing(self, claims, failure):
        """Only the claim's own ConditionalCheckFailed is a retried delivery; anything else is a failure, metered."""
        from _shared.base_ingestor import fan_out_once

        claims.table.transact_write_items.side_effect = failure
        fan_out_once('test_source', dict(SCHEDULED_TICK))

        claims.fan_out.assert_not_called()
        claims.metrics.add_metric.assert_called_once_with(name='IngestFanOutFailures', unit='Count', value=1)


class TestEverythingARunKeepsIsItsWorkspaces:
    """Two workspaces of one plugin never share a watermark, a run row, a raw object, a breaker or a secret."""

    def test_the_secret_read_is_the_workspaces_own(self, ingestor_aws):
        ingestor_yielding()
        ingestor_yielding(scope=OTHER_SCOPE)

        assert [c.args[0] for c in ingestor_aws.get_secret.call_args_list] == [
            SECRET_NAME, f'/voc/ws/{OTHER_WS}/credentials/test_source']

    def test_no_secret_is_read_without_the_prefix(self, ingestor_aws, monkeypatch):
        monkeypatch.setattr('_shared.base_ingestor.WORKSPACE_PARAMETER_PREFIX', '')

        assert ingestor_yielding().secrets == {}
        ingestor_aws.get_secret.assert_not_called()

    def test_watermarks_never_collide(self, ingestor_aws):
        ingestor_yielding().set_watermark('last_id', 'a')
        ingestor_yielding(scope=OTHER_SCOPE).set_watermark('last_id', 'b')

        keys = [c.kwargs['Item']['source'] for c in ingestor_aws.table.put_item.call_args_list]
        assert keys == [f'WS#{WS}#test_source#last_id', f'WS#{OTHER_WS}#test_source#last_id']

    @patch('_shared.base_ingestor.AGGREGATES_TABLE', 'voc-aggregates-test')
    def test_run_rows_never_collide(self, ingestor_aws):
        ingestor_yielding(execution_id='exec-1')._update_source_run_status({'status': 'running'})
        ingestor_yielding(scope=OTHER_SCOPE, execution_id='exec-1')._update_source_run_status({'status': 'running'})

        keys = [c.kwargs['Key'] for c in ingestor_aws.table.update_item.call_args_list]
        assert keys == [{'pk': f'WS#{WS}#SOURCE_RUN#test_source', 'sk': 'exec-1'},
                        {'pk': f'WS#{OTHER_WS}#SOURCE_RUN#test_source', 'sk': 'exec-1'}]

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', 'test-bucket')
    def test_raw_objects_go_under_each_workspaces_own_root(self, ingestor_aws):
        item = {'id': 'review-1', 'text': 'Same review', 'created_at': '2025-01-02T10:00:00Z'}

        first = ingestor_yielding().normalize_item(dict(item))
        second = ingestor_yielding(scope=OTHER_SCOPE).normalize_item(dict(item))

        keys = [c.kwargs['Key'] for c in ingestor_aws.s3.put_object.call_args_list]
        assert keys[0].startswith(f'ws/{WS}/raw/test_source/2025/01/02/')
        assert keys[1].startswith(f'ws/{OTHER_WS}/raw/test_source/2025/01/02/')
        assert keys[0].removeprefix(f'ws/{WS}/') == keys[1].removeprefix(f'ws/{OTHER_WS}/')
        assert first['s3_raw_uri'] == f's3://test-bucket/{keys[0]}'
        assert second['s3_raw_uri'] == f's3://test-bucket/{keys[1]}'
        assert all(c.kwargs['IfNoneMatch'] == '*' for c in ingestor_aws.s3.put_object.call_args_list)

    @pytest.mark.usefixtures('ingestor_aws')
    def test_the_breaker_is_the_workspaces(self):
        assert ingestor_yielding().circuit_breaker.scope == SCOPE
        assert ingestor_yielding(scope=OTHER_SCOPE).circuit_breaker.scope == OTHER_SCOPE

    def test_a_key_of_another_workspace_is_refused_before_any_call(self, ingestor_aws):
        from shared.ws_repo import OutOfScopeError

        ingestor = ingestor_yielding()
        with pytest.raises(OutOfScopeError):
            ingestor.watermarks_table.get_item({'source': f'WS#{OTHER_WS}#test_source#last_id'})
        ingestor_aws.table.get_item.assert_not_called()


class TestEveryMessageNamesTheRunsWorkspace:
    """``workspace_id`` is set from the scope after every field of the item, so no payload can choose it."""

    def test_each_queued_message_carries_the_scope(self, ingestor_aws):
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        with patch('_shared.sqs_utils.metrics'):
            ingestor_yielding().send_to_queue([{'id': 'a', 'text': 'One'}, {'id': 'b', 'text': 'Two'}])

        assert [m['workspace_id'] for m in _sent_messages(ingestor_aws.sqs)] == [WS, WS]

    def test_an_item_naming_another_workspace_cannot_override_it(self, ingestor_aws):
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        with patch('_shared.sqs_utils.metrics'):
            ingestor_yielding().send_to_queue([{'id': 'a', 'text': 'One', 'workspace_id': OTHER_WS}])

        assert [m['workspace_id'] for m in _sent_messages(ingestor_aws.sqs)] == [WS]

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_a_plugin_that_copies_source_fields_onto_its_message_cannot_override_it(self, ingestor_aws):
        """A subclass whose normalize_item carries the source's own fields (as web_reviews and synthetic_reviews
        carry theirs) still sends the run's workspace."""
        from _shared.base_ingestor import BaseIngestor

        class CopyingIngestor(BaseIngestor):
            def fetch_new_items(self):
                yield {'id': '1', 'text': 'Spoofed', 'created_at': '2025-01-01T00:00:00Z', 'workspace_id': OTHER_WS}

            def normalize_item(self, item, raw_content=None):
                return {**super().normalize_item(dict(item), raw_content), **item}

        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        ingestor = with_mock_circuit_breaker(CopyingIngestor(SCOPE))
        with patch('_shared.sqs_utils.metrics'), patch('_shared.base_ingestor.emit_audit_event'):
            assert ingestor.run()['status'] == 'success'

        assert [m['workspace_id'] for m in _sent_messages(ingestor_aws.sqs)] == [WS]

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_every_audit_event_of_a_run_names_its_workspace(self, ingestor_aws):
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        ingestor = with_mock_circuit_breaker(ingestor_yielding(THREE_REVIEWS[:1]))
        with patch('_shared.sqs_utils.metrics'), patch('_shared.base_ingestor.emit_audit_event') as audit:
            ingestor.run()

        assert [c.args[0] for c in audit.call_args_list] == ['plugin.invoked', 'message.ingested', 'plugin.completed']
        assert all(c.args[3]['workspace_id'] == WS for c in audit.call_args_list)


class TestTheDeploymentWidePathIsUnchanged:
    """A run whose event names no workspace (scope None) does exactly what it did before workspaces: the old keys,
    the shared secret, ``raw/``, no ``workspace_id`` anywhere. It stays until phase 2's last slice."""

    def test_it_reads_the_shared_secret(self, ingestor_aws):
        with patch('_shared.base_ingestor.SECRETS_ARN', 'arn:shared'):
            ingestor_yielding(scope=None)

        ingestor_aws.get_secret.assert_called_once_with('arn:shared')

    def test_without_the_shared_secret_it_reads_nothing(self, ingestor_aws):
        with patch('_shared.base_ingestor.SECRETS_ARN', ''):
            assert ingestor_yielding(scope=None).secrets == {}
        ingestor_aws.get_secret.assert_not_called()

    def test_its_watermarks_keep_the_deployment_wide_key(self, ingestor_aws):
        ingestor_aws.table.get_item.return_value = {'Item': {'value': '42'}}
        ingestor = ingestor_yielding(scope=None)

        assert ingestor.get_watermark('last_id') == '42'
        ingestor.set_watermark('last_id', '43')

        ingestor_aws.table.get_item.assert_called_once_with(Key={'source': 'test_source#last_id'})
        assert ingestor_aws.table.put_item.call_args.kwargs['Item']['source'] == 'test_source#last_id'

    @patch('_shared.base_ingestor.AGGREGATES_TABLE', 'voc-aggregates-test')
    def test_its_run_row_is_the_one_the_api_polls(self, ingestor_aws):
        ingestor_yielding(scope=None, execution_id='exec-1')._update_source_run_status({'status': 'running'})

        assert ingestor_aws.table.update_item.call_args.kwargs['Key'] == {'pk': 'SOURCE_RUN#test_source', 'sk': 'exec-1'}

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', 'test-bucket')
    def test_its_raw_objects_stay_under_raw(self, ingestor_aws):
        result = ingestor_yielding(scope=None).normalize_item(
            {'id': 'review-1', 'text': 'Same review', 'created_at': '2025-01-02T10:00:00Z'})

        key = ingestor_aws.s3.put_object.call_args.kwargs['Key']
        assert key.startswith('raw/test_source/2025/01/02/')
        assert result['s3_raw_uri'] == f's3://test-bucket/{key}'

    def test_its_messages_carry_no_workspace(self, ingestor_aws):
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        with patch('_shared.sqs_utils.metrics'):
            ingestor_yielding(scope=None).send_to_queue([{'id': 'a', 'text': 'One'}])

        assert ['workspace_id' in m for m in _sent_messages(ingestor_aws.sqs)] == [False]

    @patch('_shared.base_ingestor.RAW_DATA_BUCKET', '')
    def test_its_audit_events_are_the_ones_it_always_emitted(self, ingestor_aws):
        ingestor_aws.sqs.send_message_batch.side_effect = echo_batch_success
        ingestor = with_mock_circuit_breaker(ingestor_yielding(THREE_REVIEWS[:1], scope=None))
        with patch('_shared.sqs_utils.metrics'), patch('_shared.base_ingestor.emit_audit_event') as audit:
            ingestor.run()

        assert audit.call_args_list == [
            call('plugin.invoked', 'test_source', True, {}),
            call('message.ingested', 'test_source', True, {'message_id': '1'}),
            call('plugin.completed', 'test_source', True, {'items_processed': 1}),
        ]

    @pytest.mark.usefixtures('ingestor_aws')
    def test_its_breaker_is_the_deployment_wide_one(self):
        assert ingestor_yielding(scope=None).circuit_breaker.scope is None


class TestAWorkspaceWithoutThePluginsCredentials:
    """A run in a workspace with none of the plugin's keys saved (neither of its parameters exists; the plugins'
    double, plugins/conftest.py, keeps only the plugin's own keys of a payload): it ends ``error`` naming the missing credentials and never counts against the workspace's breaker,
    so an admin who has not saved them yet does not find the plugin stopped there after a few runs."""

    @pytest.mark.parametrize('stored', [{}, {'other_plugin_api_key': 'k'}], ids=['empty', 'another-plugin'])
    @patch('_shared.base_ingestor.AGGREGATES_TABLE', 'voc-aggregates-test')
    def test_the_run_fails_naming_them_and_the_breaker_does_not_count_it(self, ingestor_aws, stored):
        from shared.exceptions import WorkspaceCredentialsNotSet

        ingestor_aws.get_secret.return_value = stored
        with patch('_shared.circuit_breaker.CircuitBreaker.record_failure') as counted, \
                patch('_shared.base_ingestor.emit_audit_event') as audit, \
                pytest.raises(WorkspaceCredentialsNotSet, match="No credentials of 'test_source'"):
            ingestor_yielding(execution_id='exec-1')

        counted.assert_not_called()
        update = ingestor_aws.table.update_item.call_args.kwargs
        assert update['Key'] == {'pk': f'WS#{WS}#SOURCE_RUN#test_source', 'sk': 'exec-1'}
        assert ['WorkspaceCredentialsNotSet'] in update['ExpressionAttributeValues'].values()
        assert audit.call_args.args[3]['counted_against_circuit_breaker'] is False

    def test_deployment_wide_a_namespace_miss_still_counts(self, ingestor_aws):
        from shared.exceptions import ConfigurationError, WorkspaceCredentialsNotSet

        ingestor_aws.get_secret.return_value = {'other_plugin_api_key': 'k'}
        with patch('_shared.base_ingestor.SECRETS_ARN', 'arn:shared'), \
                patch('_shared.circuit_breaker.CircuitBreaker.record_failure') as counted, \
                pytest.raises(ConfigurationError) as raised:
            ingestor_yielding(scope=None)

        assert not isinstance(raised.value, WorkspaceCredentialsNotSet)
        counted.assert_called_once()
