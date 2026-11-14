"""voc-retention: the pins the whole-module mutation run of handler.py found missing (the walk's own lines were
done first; these are the run's setup, its resume, its finish and the cached reads it moves on).

- the daily run's cutoffs are counted from today's date in UTC, and each store gets its own filter;
- an erase event without a string value, or whose workspace_id names no workspace, is refused, said in the log by
  its own words, before any read; a job row naming another workspace than its partition fails with its own message;
- a hand-over naming a phase this run does not walk starts the run from its first phase, from the start;
- a failed lock release is logged as a release; the deletes metric adds the Radar items;
- a cached read moves on (data_version, radar version) only when this invocation deleted something of its kind.
"""
from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any
from unittest.mock import MagicMock, call, patch

import pytest
from botocore.exceptions import ClientError

from jobs.retention import handler
from jobs.retention.test.walk_store import expired, key, left
from shared import retention
from shared.digests import sha256_hex
from shared.retention import STORE_FEEDBACK, STORE_RADAR

JOB_ID = 'er_0123456789ab'
WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8'
PROFILES = [{'id': 'web', 'retention_days': 30}]


class _UtcToday:
    """``datetime`` as the handler reads it: 2026-03-01 00:30, and only when asked in UTC (a local clock's date
    can be the day before)."""

    @staticmethod
    def now(tz: Any) -> datetime:
        if tz is not UTC:
            raise AssertionError('the date is read in UTC')
        return datetime(2026, 3, 1, 0, 30, tzinfo=UTC)


def _counts(**fields: Any) -> dict[str, Any]:
    """A finishing erasure job's run: every counter at 0, then ``fields``."""
    base = {'mode': 'erase', 'run_id': 'r1', 'started_at': 'S', 'deleted_items': 0, 'deleted_objects': 0,
            'deleted_radar_items': 0, 'artifacts_marked': 0, 'job_id': JOB_ID}
    return {**base, **fields}


class TestTheDailyRunsSetup:
    def _setup(self) -> tuple[Any, dict[str, Any]]:
        run: dict[str, Any] = {}
        with patch.object(handler, 'load_source_profiles', return_value=PROFILES), \
                patch.object(handler, 'datetime', _UtcToday):
            filters = handler._retention_setup(MagicMock(), run)
        return filters, run

    def test_the_cutoffs_count_back_from_todays_date_in_utc(self) -> None:
        _filters, run = self._setup()
        assert run['cutoffs'] == {'web': '2026-01-30'}
        assert run['cutoffs'] == retention.retention_cutoffs(PROFILES, date(2026, 3, 1))

    def test_each_store_gets_its_own_filter(self) -> None:
        filters, run = self._setup()
        assert filters is not None
        assert filters(STORE_RADAR) == retention.retention_filter(run['cutoffs'], STORE_RADAR)
        # The two stores' filters differ, so a handler that dropped the store (the feedback default) would show.
        assert filters(STORE_RADAR) != retention.retention_filter(run['cutoffs'], STORE_FEEDBACK)


class TestARefusedEraseEvent:
    def test_a_value_that_is_not_a_string_is_refused_before_any_read(self) -> None:
        table = MagicMock()
        with patch.object(handler, 'logger') as logger:
            assert handler._erase_setup(table, {'job_id': JOB_ID, 'value': 5}, {}) is None
        logger.error.assert_called_once_with('Erasure event without a valid job_id and value')
        table.update_item.assert_not_called()

    def test_a_workspace_id_that_names_no_workspace_is_refused_and_logged_with_the_job(self) -> None:
        table = MagicMock()
        with patch.object(handler, 'logger') as logger:
            assert handler._erase_setup(table, {'job_id': JOB_ID, 'value': 'x', 'workspace_id': 'nope'}, {}) is None
        logger.error.assert_called_once_with('Erasure event whose workspace_id names no workspace',
                                             extra={'job_id': JOB_ID})
        table.update_item.assert_not_called()

    def test_a_job_row_naming_another_workspace_than_its_partition_fails_with_its_own_message(self) -> None:
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'field': 'author', 'value_hash': sha256_hex('x'),
                                                         'workspace_id': WS}}
        with pytest.raises(ValueError, match=r'^The job row names another workspace than its partition$'):
            handler._erase_setup(table, {'job_id': JOB_ID, 'value': 'x'}, {'generation': 0})


@pytest.mark.usefixtures('three_a_page')
def test_a_hand_over_naming_a_phase_this_run_does_not_walk_starts_from_the_first(aws, worker_context,
                                                                                invoke_mock) -> None:
    expired(aws, 6)
    # A daily run has no boards phase: its cursor belongs to none of this run's phases.
    result = handler.handle_event({'phase': 'boards', 'cursor': key('a2')}, worker_context)
    assert (result['status'], result['deleted_items']) == ('completed', 6)
    assert left(aws) == []
    invoke_mock.assert_not_called()


class TestTheFinish:
    def _finish(self, run: dict[str, Any], **patches: Any) -> tuple[dict, MagicMock, MagicMock]:
        with patch.object(handler, 'finish_erasure_job', return_value=True), patch.object(handler, 'write_audit'), \
                patch.object(handler, 'metrics') as metrics, patch.object(handler, 'logger') as logger, \
                patch.multiple(handler, **patches):
            result = handler._finish(MagicMock(), run, 'completed')
        return result, metrics, logger

    def test_a_failed_source_lock_release_is_logged_as_a_release(self) -> None:
        refused = MagicMock(side_effect=ClientError({'Error': {'Code': 'Throttling'}}, 'UpdateItem'))
        _result, _metrics, logger = self._finish(_counts(field=handler.SOURCE_FIELD, source='web'),
                                                 release_source_lock=refused)
        assert logger.warning.call_args_list == [call('Could not update the source erasure lock',
                                                      extra={'action': 'release', 'error_type': 'ClientError'})]

    def test_a_failed_workspace_lock_release_is_logged_as_a_release(self) -> None:
        refused = MagicMock(side_effect=ClientError({'Error': {'Code': 'Throttling'}}, 'UpdateItem'))
        _result, _metrics, logger = self._finish(_counts(workspace_id=WS), release_workspace_lock=refused)
        assert logger.warning.call_args_list == [call('Could not update the workspace erasure lock',
                                                      extra={'action': 'release', 'error_type': 'ClientError'})]

    def test_the_deletes_metric_adds_the_radar_items(self) -> None:
        result, metrics, _logger = self._finish(_counts(deleted_items=2, deleted_radar_items=3),
                                                release_source_lock=MagicMock(), release_workspace_lock=MagicMock())
        metrics.add_metric.assert_called_once_with(name='RetentionItemsDeleted', unit='Count', value=5)
        assert (result['deleted_items'], result['deleted_radar_items']) == (2, 3)


@pytest.mark.usefixtures('aws')
class TestTheCachedReadsMoveOnOnlyForThisInvocationsDeletes:
    def _run(self, event: dict[str, Any], context: MagicMock) -> tuple[dict, MagicMock, MagicMock]:
        with patch.object(handler, 'bump_data_version') as data, patch.object(handler, 'bump_radar_version') as radar:
            result = handler.handle_event(event, context)
        return result, data, radar

    def test_items_carried_from_earlier_invocations_move_nothing(self, worker_context) -> None:
        _result, data, radar = self._run({'run': {'deleted_items': 5, 'deleted_radar_items': 3}}, worker_context)
        data.assert_not_called()
        radar.assert_not_called()

    def test_a_workspace_job_that_deleted_nothing_moves_nothing(self, worker_context) -> None:
        # The job row is missing: the run reads nothing and deletes nothing (its partition is on the run already).
        result, data, _radar = self._run({'mode': 'erase', 'job_id': JOB_ID, 'value': 'x', 'workspace_id': WS},
                                         worker_context)
        assert result['status'] == 'nothing_to_do'
        data.assert_not_called()

    @pytest.mark.usefixtures('three_a_page')
    def test_a_daily_run_moves_the_deployments_version_even_if_its_event_names_a_workspace(
            self, aws, worker_context) -> None:
        # Only an erasure job's own partition puts a workspace on the run; a daily event's carried state cannot.
        expired(aws, 2)
        result, data, _radar = self._run({'run': {'workspace_id': WS}}, worker_context)
        assert (result['status'], result['deleted_items']) == ('completed', 2)
        data.assert_called_once_with(aws['aggregates'])
