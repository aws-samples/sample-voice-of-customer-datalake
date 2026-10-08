"""Mutation hardening for `_shared/base_ingestor.py`.

`test_base_ingestor.py` and `test_plugin_secret_isolation.py` prove the
ingestor's outcomes (secrets filtered, SQS failures propagate, the watermark is
held back) but a mutation run found 88 mutants they could not see — everything
pinned only by exact arguments:

* the IMPORT-TIME contract: each of the seven settings is read from the
  variable of that exact name and defaults to ``''``; the plugins root goes to
  the FRONT of ``sys.path``;
* the CLASS shape: ``fetch_new_items`` is abstract and the run-status writer is
  wrapped by the Powertools tracer;
* the CONSTRUCTION-FAILURE report: the exact ``plugin.failed`` audit details
  (``phase``, ``counted_against_circuit_breaker``), the exact run-status update
  and one warning per reporting step that fails;
* the RUN-STATUS WRITE itself: the ``SET #k = :k, ...`` expression, its name and
  value maps, and that it is skipped without an execution id;
* ``run()``'s sequence: every audit event with its success flag, every status
  update in order (including the progress write at exactly 100 items), the
  accumulated count across batches, the watermark key, and the error path's
  metric, log line and audit event;
* the delegations: the ``source_platform_override`` and ``"unknown"`` channel in
  ``normalize_item``/``store_raw_to_s3``, ``raw_data`` only when there is no S3
  copy, and ``send_to_queue``'s metric name and log label;
* every warning text (and ``exc_info``) on the DynamoDB failure paths.
"""
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import ANY, MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from _shared import base_ingestor
from _shared.base_ingestor import BaseIngestor
from _shared.test.fresh_import import assert_loading_puts_root_first, load_fresh
from _shared.test.ingestor_fixtures import breaker_mock, ingestor_yielding, with_mock_circuit_breaker
from shared.exceptions import ConfigurationError

MODULE_PATH = Path(base_ingestor.__file__).resolve()
PLUGINS_ROOT = str(MODULE_PATH.parents[1])
PLATFORM = 'test_source'
EXECUTION_ID = 'exec-1'
RUN_KEY = {'pk': f'SOURCE_RUN#{PLATFORM}', 'sk': EXECUTION_ID}
ENV_SETTINGS = (
    'WATERMARKS_TABLE',
    'PROCESSING_QUEUE_URL',
    'RAW_DATA_BUCKET',
    'SECRETS_ARN',
    'BRAND_NAME',
    'SOURCE_PLATFORM',
    'AGGREGATES_TABLE',
)
CLIENT_ERROR = ClientError({'Error': {'Code': 'Throttling', 'Message': 'slow down'}}, 'Op')


def _load_fresh_module():
    return load_fresh('_shared._base_ingestor_under_test', MODULE_PATH)


def _reviews(count: int) -> list[dict]:
    return [{'id': str(i), 'text': f'Review {i}'} for i in range(count)]


def _construct(cls: type[BaseIngestor]) -> BaseIngestor:
    """Construct *cls* the way a plugin handler does, through a variable of the base type."""
    return cls()


@pytest.fixture
def restored_sys_path(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Give the test a throwaway copy of `sys.path`; monkeypatch puts the real one back."""
    snapshot = list(sys.path)
    monkeypatch.setattr(sys, 'path', list(snapshot))
    return snapshot


@pytest.fixture
def ingestor_logger() -> Iterator[MagicMock]:
    with patch('_shared.base_ingestor.logger') as logger:
        yield logger


@pytest.fixture
def run_env(ingestor_aws) -> Iterator[SimpleNamespace]:
    """A manual run's doubles: an aggregates table, the audit emitter, metrics."""
    with (
        patch('_shared.base_ingestor.AGGREGATES_TABLE', 'test-aggregates'),
        patch('_shared.base_ingestor.emit_audit_event') as emit,
        patch('_shared.base_ingestor.metrics') as metrics,
    ):
        yield SimpleNamespace(table=ingestor_aws.table, emit=emit, metrics=metrics, aws=ingestor_aws)


def _status_values(table: MagicMock) -> list[dict]:
    return [c.kwargs['ExpressionAttributeValues'] for c in table.update_item.call_args_list]


class TestTheImportTimeContract:
    @pytest.mark.usefixtures('restored_sys_path')
    def test_each_setting_is_read_from_the_variable_of_that_exact_name(self):
        values = {name: f'from-env-{name}' for name in ENV_SETTINGS}
        with patch.dict(os.environ, values):
            module = _load_fresh_module()

        assert {name: getattr(module, name) for name in ENV_SETTINGS} == values

    @pytest.mark.usefixtures('restored_sys_path')
    def test_each_setting_defaults_to_the_empty_string(self):
        with patch.dict(os.environ):
            for name in ENV_SETTINGS:
                os.environ.pop(name, None)
            module = _load_fresh_module()

        assert {name: getattr(module, name) for name in ENV_SETTINGS} == dict.fromkeys(ENV_SETTINGS, '')

    def test_the_plugins_root_is_put_at_the_front_of_sys_path(self, restored_sys_path):
        assert_loading_puts_root_first(_load_fresh_module, restored_sys_path, PLUGINS_ROOT)


class TestTheClassShape:
    def test_a_subclass_without_fetch_new_items_cannot_be_constructed(self):
        class Incomplete(BaseIngestor):
            """Implements nothing."""

        with pytest.raises(TypeError, match='fetch_new_items'):
            _construct(Incomplete)

    def test_the_run_status_writer_is_wrapped_by_the_tracer(self):
        writer = vars(BaseIngestor)['_update_source_run_status']
        assert writer.__code__.co_filename.endswith(os.path.join('tracing', 'tracer.py'))
        wrapped = vars(writer).get('__wrapped__')
        assert wrapped is not None
        assert wrapped.__qualname__ == 'BaseIngestor._update_source_run_status'


class TestTheConstructionFailureReport:
    @pytest.mark.parametrize(
        ('payload', 'error_type', 'counted'),
        [
            pytest.param({'other_plugin_key': 'x'}, 'ConfigurationError', True, id='namespace_miss'),
            pytest.param({}, 'SecretUnreadableError', False, id='unreadable'),
        ],
    )
    def test_reports_the_exact_audit_event_run_status_and_breaker_failure(
        self, run_env, payload, error_type, counted
    ):
        run_env.aws.get_secret.return_value = payload
        with (
            patch('_shared.base_ingestor.clear_secret_cache'),
            patch.object(base_ingestor.CircuitBreaker, 'record_failure') as record_failure,
            pytest.raises(ConfigurationError) as excinfo,
        ):
            ingestor_yielding(execution_id=EXECUTION_ID)

        message = str(excinfo.value)
        assert type(excinfo.value).__name__ == error_type
        run_env.emit.assert_called_once_with('plugin.failed', PLATFORM, False, {
            'error': message,
            'error_type': error_type,
            'phase': 'construction',
            'counted_against_circuit_breaker': counted,
        })
        run_env.table.update_item.assert_called_once_with(
            Key=RUN_KEY,
            UpdateExpression='SET #status = :status, #items_found = :items_found, '
                             '#completed_at = :completed_at, #errors = :errors',
            ExpressionAttributeNames={
                '#status': 'status', '#items_found': 'items_found',
                '#completed_at': 'completed_at', '#errors': 'errors',
            },
            ExpressionAttributeValues={
                ':status': 'error', ':items_found': 0, ':completed_at': ANY, ':errors': [error_type],
            },
        )
        assert record_failure.call_args_list == ([call(message)] if counted else [])

    def test_each_failing_reporting_step_logs_its_own_warning(self, run_env, ingestor_logger):
        run_env.aws.get_secret.return_value = {'other_plugin_key': 'x'}
        run_env.emit.side_effect = Exception('bus gone')
        run_env.table.update_item.side_effect = Exception('table gone')
        with (
            patch.object(base_ingestor.CircuitBreaker, 'record_failure', side_effect=Exception('breaker gone')),
            pytest.raises(ConfigurationError),
        ):
            ingestor_yielding(execution_id=EXECUTION_ID)

        assert ingestor_logger.warning.call_args_list == [
            call('Failed to emit construction failure audit event: bus gone'),
            call('Failed to record construction failure run status: table gone'),
            call('Failed to record construction failure with the circuit breaker: breaker gone'),
        ]


class TestSecretsAndWatermarks:
    def test_an_unset_secrets_arn_warns_and_reads_nothing(self, ingestor_aws, ingestor_logger):
        with patch('_shared.base_ingestor.SECRETS_ARN', ''):
            ingestor = ingestor_yielding()

        assert ingestor.secrets == {}
        ingestor_aws.get_secret.assert_not_called()
        ingestor_logger.warning.assert_called_once_with('SECRETS_ARN not configured')

    def test_a_failed_watermark_read_returns_the_default_and_warns(self, ingestor_aws, ingestor_logger):
        ingestor_aws.table.get_item.side_effect = CLIENT_ERROR

        assert ingestor_yielding().get_watermark('last_id', default='d') == 'd'
        ingestor_logger.warning.assert_called_once_with(f'Failed to get watermark: {CLIENT_ERROR}', exc_info=True)

    def test_a_failed_watermark_write_is_logged_with_its_cause(self, ingestor_aws, ingestor_logger):
        ingestor_aws.table.put_item.side_effect = CLIENT_ERROR

        ingestor_yielding().set_watermark('last_id', '9')

        ingestor_logger.exception.assert_called_once_with(f'Failed to save watermark: {CLIENT_ERROR}')


class TestTheDelegations:
    @pytest.mark.parametrize(
        ('item', 'platform'),
        [({'id': 'a', 'source_platform_override': 'other'}, 'other'), ({'id': 'a'}, PLATFORM)],
    )
    def test_store_raw_to_s3_archives_under_the_override_or_the_platform(self, ingestor_aws, item, platform):
        with patch('_shared.base_ingestor.archive_raw_item', return_value='s3://b/k') as archive:
            uri = ingestor_yielding().store_raw_to_s3(item, 'raw')

        assert uri == 's3://b/k'
        archive.assert_called_once_with(ingestor_aws.s3, base_ingestor.RAW_DATA_BUCKET, platform, item, 'raw')

    @pytest.mark.parametrize(('uri', 'carries_raw'), [(None, True), ('s3://b/k', False)])
    @pytest.mark.usefixtures('ingestor_aws')
    def test_normalize_item_uses_the_override_the_unknown_channel_and_raw_data_only_without_a_copy(
        self, uri, carries_raw
    ):
        item = {'id': 'a', 'source_platform_override': 'other'}
        with patch('_shared.base_ingestor.archive_raw_item', return_value=uri):
            result = ingestor_yielding().normalize_item(item)

        assert result['source_platform'] == 'other'
        assert result['source_channel'] == 'unknown'
        assert result['s3_raw_uri'] == uri
        assert result['raw_data'] == (item if carries_raw else None)

    def test_send_to_queue_names_the_metric_and_the_log_label(self, ingestor_aws):
        items = [{'id': 'a'}]
        with patch('_shared.base_ingestor.send_messages_to_queue', return_value=1) as send:
            assert ingestor_yielding().send_to_queue(items) == 1

        send.assert_called_once_with(
            ingestor_aws.sqs, base_ingestor.PROCESSING_QUEUE_URL, [{'id': 'a', 'pii_policy_applied': 'allow'}],
            metric_name='ItemsIngested', log_label='ingestor',
        )


class TestTheRunStatusWrite:
    def test_writes_one_set_expression_naming_every_field(self, run_env):
        ingestor_yielding(execution_id=EXECUTION_ID)._update_source_run_status({'status': 'x', 'items_found': 3})

        run_env.table.update_item.assert_called_once_with(
            Key=RUN_KEY,
            UpdateExpression='SET #status = :status, #items_found = :items_found',
            ExpressionAttributeNames={'#status': 'status', '#items_found': 'items_found'},
            ExpressionAttributeValues={':status': 'x', ':items_found': 3},
        )

    def test_is_skipped_without_an_execution_id(self, run_env):
        ingestor_yielding()._update_source_run_status({'status': 'x'})

        run_env.table.update_item.assert_not_called()

    @pytest.mark.parametrize('error', [CLIENT_ERROR, TypeError('bad value')])
    def test_a_failed_write_warns_with_its_cause(self, run_env, ingestor_logger, error):
        run_env.table.update_item.side_effect = error

        ingestor_yielding(execution_id=EXECUTION_ID)._update_source_run_status({'status': 'x'})

        ingestor_logger.warning.assert_called_once_with(f'Failed to update run status: {error}', exc_info=True)


def _run(items: list[dict], sent: list[int]):
    """Run a manual ingestor over *items* whose send_to_queue returns *sent* in turn."""
    ingestor = with_mock_circuit_breaker(ingestor_yielding(items, execution_id=EXECUTION_ID))
    with patch.object(type(ingestor), 'send_to_queue', side_effect=sent) as send:
        result = ingestor.run()
    return ingestor, result, send


class TestARun:
    def test_an_open_breaker_logs_the_skip(self, run_env, ingestor_logger):
        ingestor = with_mock_circuit_breaker(ingestor_yielding(), is_open=True)

        assert ingestor.run() == {'status': 'skipped', 'reason': 'circuit_breaker_open'}
        ingestor_logger.warning.assert_called_once_with(f'Circuit breaker open for {PLATFORM}, skipping')
        run_env.emit.assert_not_called()

    def test_batches_accumulate_and_every_step_is_recorded_in_order(self, run_env):
        items = _reviews(250)

        ingestor, result, send = _run(items, [100, 100, 50])

        assert result == {'status': 'success', 'items_processed': 250}
        assert [len(c.args[0]) for c in send.call_args_list] == [100, 100, 50]
        assert _status_values(run_env.table) == [
            {':status': 'running', ':items_found': 0, ':started_at': ANY},
            {':items_found': 100},
            {':items_found': 200},
            {':status': 'completed', ':items_found': 250, ':completed_at': ANY},
        ]
        run_env.table.put_item.assert_called_once_with(
            Item={'source': f'{PLATFORM}#last_id', 'value': '249', 'updated_at': ANY}
        )
        assert run_env.emit.call_args_list == [
            call('plugin.invoked', PLATFORM, True),
            *(call('message.ingested', PLATFORM, True, {'message_id': item['id']}) for item in items),
            call('plugin.completed', PLATFORM, True, {'items_processed': 250}),
        ]
        breaker_mock(ingestor).record_success.assert_called_once_with()

    @pytest.mark.parametrize(
        ('count', 'progress'),
        [(99, []), (100, [{':items_found': 100}]), (101, [{':items_found': 100}])],
    )
    def test_the_progress_write_comes_at_exactly_one_hundred_items(self, run_env, count, progress):
        sent = [min(count, 100)] + ([count - 100] if count > 100 else [])

        _run(_reviews(count), sent)

        assert _status_values(run_env.table)[1:-1] == progress

    def test_a_failure_logs_counts_and_reports_its_type(self, run_env, ingestor_logger):
        class Exploding(BaseIngestor):
            def fetch_new_items(self):
                raise ValueError('boom')

        ingestor = with_mock_circuit_breaker(Exploding(execution_id=EXECUTION_ID))
        with pytest.raises(ValueError, match='boom'):
            ingestor.run()

        ingestor_logger.exception.assert_called_once_with('Ingestion failed: boom')
        run_env.metrics.add_metric.assert_called_once_with(name='IngestionErrors', unit='Count', value=1)
        assert _status_values(run_env.table)[-1] == {
            ':status': 'error', ':items_found': 0, ':completed_at': ANY, ':errors': ['ValueError'],
        }
        breaker_mock(ingestor).record_failure.assert_called_once_with('boom')
        assert run_env.emit.call_args_list[-1] == call(
            'plugin.failed', PLATFORM, False, {'error': 'boom', 'error_type': 'ValueError'}
        )
