"""voc-retention: the pins the mutation run found missing from the moto suite.

The moto suite proves the right rows go; it never looked at the run's own bookkeeping. A mutation
run showed that nothing pinned: the env names and their empty defaults, the page size, the time
reserve and the generation cap as literal boundaries, every key of the audit row and of the job's
outcome update, the counters carried across a hand-over, the scan cursor (from the event, after
each deleted item, from `LastEvaluatedKey`), the hand-over between pages, the log lines and the
metric, and the handler's instrumentation stack.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from jobs.retention import handler, runs
from jobs.retention.test.conftest import days_ago
from shared.digests import sha256_hex
from shared.test.instrumentation_fixtures import INSTRUMENTED_HANDLER_LAYERS, handler_layers

JOB_ID = 'er_0123456789ab'
NOW = '2026-01-01T00:00:00+00:00'
CONDITION: Any = object()


def _run(**overrides: Any) -> dict[str, Any]:
    return {'mode': 'retention', 'run_id': 'r1', 'started_at': 'S', 'generation': 0, 'scanned': 0,
            'deleted_items': 0, 'deleted_objects': 0, 'deleted_radar_items': 0, 'artifacts_marked': 0,
            'erased_sources': [], 'review_files': [], 'review_files_more': False, **overrides}


def _context(*budgets: int) -> MagicMock:
    context = MagicMock()
    context.function_name = 'voc-retention'
    remaining = iter(budgets)
    context.get_remaining_time_in_millis.side_effect = lambda: next(remaining, 0)
    return context


def _item(n: int) -> dict[str, str]:
    return {'pk': 'SOURCE#t', 'sk': f'FEEDBACK#{n}'}


class TestTheModuleReadsItsEnvironment:
    def _fresh(self) -> Any:
        spec = importlib.util.spec_from_file_location('retention_handler_fresh', handler.__file__)
        assert spec is not None
        assert spec.loader is not None
        fresh = importlib.util.module_from_spec(spec)
        # Registered while it runs: its dataclass resolves its annotations through sys.modules.
        with patch.dict(sys.modules, {spec.name: fresh}):
            spec.loader.exec_module(fresh)
        return fresh

    def test_each_name_is_read_from_its_variable(self) -> None:
        env = {'FEEDBACK_TABLE': 'f1', 'AGGREGATES_TABLE': 'a1', 'RAW_DATA_BUCKET': 'b1', 'RADAR_TABLE': 'r1',
               'PROJECTS_TABLE': 'p1'}
        with patch.dict(os.environ, env):
            fresh = self._fresh()
        assert (fresh.FEEDBACK_TABLE, fresh.AGGREGATES_TABLE, fresh.RAW_DATA_BUCKET, fresh.RADAR_TABLE,
                fresh.PROJECTS_TABLE) == ('f1', 'a1', 'b1', 'r1', 'p1')

    def test_an_unset_variable_reads_empty(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            fresh = self._fresh()
        assert (fresh.FEEDBACK_TABLE, fresh.AGGREGATES_TABLE, fresh.RAW_DATA_BUCKET, fresh.RADAR_TABLE,
                fresh.PROJECTS_TABLE) == ('', '', '', '', '')


class TestTheBoundaries:
    @pytest.mark.parametrize(('remaining', 'left'), [(60_000, False), (60_001, True)])
    def test_sixty_seconds_is_the_reserve(self, remaining: int, left: bool) -> None:
        assert handler._time_left(_context(remaining)) is left

    def test_one_page_is_a_hundred_items_from_the_cursor(self) -> None:
        table = MagicMock()
        handler._scan_page(table, CONDITION, None)
        handler._scan_page(table, CONDITION, {'pk': 'p', 'sk': 's'})
        assert table.scan.call_args_list[0].kwargs == {'Limit': 100, 'FilterExpression': CONDITION}
        assert table.scan.call_args_list[1].kwargs == {
            'Limit': 100, 'FilterExpression': CONDITION, 'ExclusiveStartKey': {'pk': 'p', 'sk': 's'}}

    @pytest.mark.parametrize(('generation', 'status'), [(499, 'completed'), (500, 'failed')])
    @pytest.mark.usefixtures('aws')
    def test_the_five_hundredth_hand_over_stops(self, worker_context, generation: int, status: str) -> None:
        event = {'mode': 'retention', 'run': {'generation': generation}}
        assert handler.handle_event(event, worker_context)['status'] == status


class TestTheAuditRow:
    def test_every_key_of_an_erasure_run(self) -> None:
        table = MagicMock()
        run = _run(mode='erase', scanned=7, deleted_items=2, deleted_objects=3, deleted_radar_items=4,
                   artifacts_marked=5, job_id=JOB_ID, field='author', source='web', value_hash='h',
                   cutoffs={'t': 'd'}, legal_basis='GDPR art. 17', legal_bases={'t': 'DPA'}, erased_sources=['web'],
                   review_files=['raw/csv_upload/k.csv'])
        with patch.object(runs, 'now_iso', return_value=NOW):
            runs.write_audit(table, run, 'failed', 'boom')
        table.put_item.assert_called_once_with(Item={
            'pk': 'AUDIT#retention', 'sk': f'{NOW}#r1', 'run_id': 'r1', 'mode': 'erase', 'status': 'failed',
            'deleted_items': 2, 'deleted_objects': 3, 'deleted_radar_items': 4, 'artifacts_marked': 5, 'scanned': 7,
            'started_at': 'S', 'finished_at': NOW, 'job_id': JOB_ID, 'field': 'author', 'source': 'web',
            'value_hash': 'h', 'cutoffs': {'t': 'd'}, 'legal_basis': 'GDPR art. 17', 'legal_bases': {'t': 'DPA'},
            'erased_sources': ['web'],
            'files_needing_review': {'count': 1, 'keys': ['raw/csv_upload/k.csv'], 'more': False},
            'error': 'boom'})

    def test_empty_optional_keys_and_no_error_are_left_out(self) -> None:
        table = MagicMock()
        with patch.object(runs, 'now_iso', return_value=NOW):
            runs.write_audit(table, _run(source=None, cutoffs={}), 'completed')
        assert table.put_item.call_args.kwargs['Item'] == {
            'pk': 'AUDIT#retention', 'sk': f'{NOW}#r1', 'run_id': 'r1', 'mode': 'retention', 'status': 'completed',
            'deleted_items': 0, 'deleted_objects': 0, 'deleted_radar_items': 0, 'artifacts_marked': 0, 'scanned': 0,
            'started_at': 'S', 'finished_at': NOW}

    def test_an_erasure_audit_names_the_job_from_its_row(self, aws, worker_context) -> None:
        aws['aggregates'].put_item(Item={'pk': 'JOB#erasure', 'sk': JOB_ID, 'status': 'queued', 'field': 'author',
                                         'source': 'web', 'value_hash': sha256_hex('Jane')})
        handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'Jane'}, worker_context)
        [audit] = aws['aggregates'].query(
            KeyConditionExpression='pk = :pk', ExpressionAttributeValues={':pk': 'AUDIT#retention'})['Items']
        assert (audit['job_id'], audit['field'], audit['source'], audit['value_hash']) == (
            JOB_ID, 'author', 'web', sha256_hex('Jane'))


class TestTheErasureJobRow:
    def test_a_running_job_is_claimed_again_and_stays_running(self, aws) -> None:
        aws['aggregates'].put_item(Item={'pk': 'JOB#erasure', 'sk': JOB_ID, 'status': 'running', 'started_at': 'S'})
        job = runs.claim_erasure_job(aws['aggregates'], JOB_ID)
        assert job == {'pk': 'JOB#erasure', 'sk': JOB_ID, 'status': 'running', 'started_at': 'S'}

    def test_a_queued_job_is_marked_running(self, aws) -> None:
        aws['aggregates'].put_item(Item={'pk': 'JOB#erasure', 'sk': JOB_ID, 'status': 'queued'})
        with patch.object(runs, 'now_iso', return_value=NOW):
            job = runs.claim_erasure_job(aws['aggregates'], JOB_ID)
        assert job == {'pk': 'JOB#erasure', 'sk': JOB_ID, 'status': 'running', 'started_at': NOW}

    def test_another_client_error_is_raised(self) -> None:
        table = MagicMock()
        table.update_item.side_effect = ClientError({'Error': {'Code': 'ThrottlingException'}}, 'UpdateItem')
        with pytest.raises(ClientError):
            runs.claim_erasure_job(table, JOB_ID)

    def test_a_failure_records_its_error(self) -> None:
        table = MagicMock()
        run = _run(job_id=JOB_ID, deleted_items=1, deleted_objects=2, deleted_radar_items=3, artifacts_marked=4,
                   review_files=['raw/json_upload/k.json'], review_files_more=True)
        with patch.object(runs, 'now_iso', return_value=NOW):
            runs.finish_erasure_job(table, run, 'failed', 'e')
        table.update_item.assert_called_once_with(
            Key={'pk': 'JOB#erasure', 'sk': JOB_ID},
            UpdateExpression=('SET #status = :status, deleted_items = :deleted_items, '
                              'deleted_objects = :deleted_objects, deleted_radar_items = :deleted_radar_items, '
                              'artifacts_marked = :artifacts_marked, finished_at = :now, '
                              'files_needing_review = :review, #error = :error'),
            ExpressionAttributeNames={'#status': 'status', '#error': 'error'},
            ExpressionAttributeValues={
                ':status': 'failed', ':deleted_items': 1, ':deleted_objects': 2, ':deleted_radar_items': 3,
                ':artifacts_marked': 4, ':now': NOW, ':error': 'e',
                ':review': {'count': 1, 'keys': ['raw/json_upload/k.json'], 'more': True}})


class TestTheRunState:
    def test_a_carried_run_keeps_every_counter(self) -> None:
        carried = {'run_id': 'abc', 'started_at': 'S0', 'generation': 3, 'scanned': 4, 'deleted_items': 5,
                   'deleted_objects': 6, 'deleted_radar_items': 7, 'artifacts_marked': 8, 'erased_sources': ['web'],
                   'review_files': ['raw/csv_upload/k.csv'], 'review_files_more': True}
        run = runs.new_run({'run': carried}, 'erase')
        assert run == {'mode': 'erase', **carried}
        assert runs.carried_state(run) == {**carried, 'generation': 4}

    def test_a_fresh_run_starts_at_zero_with_a_new_id(self) -> None:
        with patch.object(runs, 'now_iso', return_value=NOW), \
                patch.object(runs.uuid, 'uuid4', return_value=MagicMock(hex='0123456789abcdef')):
            run = runs.new_run({'run': 'not a dict'}, 'retention')
        assert run == _run(run_id='0123456789ab', started_at=NOW)

    def test_review_files_are_listed_once_and_capped(self) -> None:
        run = _run()
        for n in [0, 0, *range(1, runs.MAX_REVIEW_FILES + 1)]:
            runs.note_review_file(run, f'raw/csv_upload/{n}.csv')
        assert len(run['review_files']) == runs.MAX_REVIEW_FILES
        assert run['review_files_more'] is True
        assert runs.files_needing_review(_run()) is None


class TestTheScanWalk:
    def _walk(self, pages: list[dict], context: MagicMock, event: dict, run: dict,
              invoke: MagicMock) -> tuple[Any, MagicMock]:
        table = MagicMock()
        table.scan.side_effect = pages
        walk = handler.Walk({'feedback': table, 'aggregates': MagicMock()}, context, event, run,
                            lambda _store: CONDITION, MagicMock())
        with patch.object(handler, 'invoke_lambda_async', invoke), \
                patch.object(handler.ItemDeleter, 'delete', autospec=True,
                             side_effect=lambda _deleter, _item, _store: _count_one_delete(run)):
            return handler._walk_store(walk, 'items', event.get('cursor')), table

    def test_pages_follow_the_cursor_and_add_up(self) -> None:
        run = _run(scanned=3)
        pages = [{'Items': [_item(1)], 'ScannedCount': 5, 'LastEvaluatedKey': {'k': 1}},
                 {'Items': [_item(2)], 'ScannedCount': 7, 'LastEvaluatedKey': {'k': 2}}, {}]
        invoke = MagicMock()
        result, table = self._walk(pages, _context(*[900_000] * 9), {'cursor': {'k': 0}}, run, invoke)
        assert result is None
        invoke.assert_not_called()
        assert [c.kwargs.get('ExclusiveStartKey') for c in table.scan.call_args_list] == [{'k': 0}, {'k': 1}, {'k': 2}]
        assert (run['scanned'], run['deleted_items'], run['deleted_objects']) == (15, 2, 2)

    def test_a_low_budget_mid_page_hands_over_at_the_last_deleted_item(self) -> None:
        run = _run(scanned=1, deleted_items=4, deleted_objects=5, generation=2)
        pages = [{'Items': [_item(1), _item(2)], 'ScannedCount': 2}]
        invoke = MagicMock()
        result, _ = self._walk(pages, _context(900_000, 0), {}, run, invoke)
        assert result == {'status': 'continued', 'run_id': 'r1'}
        invoke.assert_called_once_with('voc-retention', {
            'mode': 'retention', 'phase': 'items', 'cursor': _item(1), 'run': {
                **runs.carried_state(_run(scanned=3, deleted_items=5, deleted_objects=6, generation=2))}})

    def test_a_low_budget_between_pages_hands_over_at_the_next_page(self) -> None:
        pages = [{'Items': [_item(1)], 'LastEvaluatedKey': {'k': 1}}]
        invoke = MagicMock()
        event = {'mode': 'erase', 'job_id': JOB_ID, 'value': 'v', 'cursor': {'k': 0}, 'run': {}}
        self._walk(pages, _context(900_000, 0), event, _run(mode='erase'), invoke)
        invoke.assert_called_once_with('voc-retention', {
            'mode': 'erase', 'job_id': JOB_ID, 'value': 'v', 'phase': 'items', 'cursor': {'k': 1},
            'run': runs.carried_state(_run(deleted_items=1, deleted_objects=1))})


def _count_one_delete(run: dict[str, Any]) -> None:
    """Stands in for ItemDeleter.delete: one item and one raw file per call."""
    run['deleted_items'] += 1
    run['deleted_objects'] += 1


class TestTheLogsAndTheResult:
    @pytest.mark.usefixtures('aws')
    def test_an_invalid_erase_event_says_so(self, worker_context) -> None:
        with patch.object(handler, 'logger') as logger:
            handler.handle_event({'mode': 'erase', 'job_id': 'nope', 'value': 'x'}, worker_context)
        logger.error.assert_called_once_with('Erasure event without a valid job_id and value')

    @pytest.mark.usefixtures('aws')
    def test_a_missing_job_is_logged_with_its_id(self, worker_context) -> None:
        with patch.object(handler, 'logger') as logger:
            handler.handle_event({'mode': 'erase', 'job_id': JOB_ID, 'value': 'x'}, worker_context)
        logger.info.assert_called_once_with('Erasure job is missing or already finished', extra={'job_id': JOB_ID})

    def test_a_mismatched_value_names_the_cause(self) -> None:
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'field': 'author', 'value_hash': 'other'}}
        with pytest.raises(ValueError, match=r'^The erasure value does not match the job$'):
            handler._erase_setup(table, {'job_id': JOB_ID, 'value': 'x'}, _run())

    def test_an_unknown_mode_is_logged_cut_to_32_characters(self) -> None:
        with patch.object(handler, 'logger') as logger:
            handler.handle_event({'mode': 'x' * 40}, MagicMock())
        logger.error.assert_called_once_with('Retention event with an unknown mode', extra={'mode': 'x' * 32})

    def test_a_failed_run_logs_its_error_type(self, aws, worker_context) -> None:
        aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config', 'sources': [{'id': 'BAD ID'}]})
        with patch.object(handler, 'logger') as logger:
            handler.handle_event({}, worker_context)
        logger.error.assert_called_once_with('Retention run failed',
                                             extra={'mode': 'retention', 'error_type': 'ValueError'})

    def test_a_finished_run_reports_and_counts_its_deletes(self, aws, worker_context) -> None:
        aws['aggregates'].put_item(Item={'pk': 'SETTINGS#sources', 'sk': 'config',
                                         'sources': [{'id': 'tickets', 'retention_days': 30}]})
        aws['feedback'].put_item(Item={'pk': 'SOURCE#tickets', 'sk': 'FEEDBACK#a', 'feedback_id': 'a',
                                       'source_id': 'a', 'source_platform': 'tickets', 'date': days_ago(60)})
        with patch.object(handler, 'metrics') as metrics, \
                patch.object(runs.uuid, 'uuid4', return_value=MagicMock(hex='abcdefabcdef0000')):
            result = handler.handle_event({}, worker_context)
        assert result == {'status': 'completed', 'run_id': 'abcdefabcdef', 'deleted_items': 1,
                          'deleted_radar_items': 0, 'deleted_objects': 0, 'artifacts_marked': 0}
        metrics.add_metric.assert_called_once_with(name='RetentionItemsDeleted', unit='Count', value=1)


def test_the_handler_carries_the_instrumentation_stack() -> None:
    assert handler_layers(handler.lambda_handler) == INSTRUMENTED_HANDLER_LAYERS
