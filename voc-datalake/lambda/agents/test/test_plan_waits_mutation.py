"""Mutation hardening for `agents/plan_waits.py`.

`test_plan_conductor.py` and `api/test/test_plan_cross_track.py` drive whole plans whose waits end
``completed`` on the first or second poll, so they only ever see the happy path of one kind at a time.
A mutation run found what such runs cannot see:

* the EXACT ROW KEY each ``wait.for`` kind reads (prefix, field, ``JOB#`` sort-key prefix), read
  consistently, and from which table;
* every ENDING: each kind's done and failed statuses and the failure wording, the unknown kind, an
  unrecorded ``{{sN.output}}``, a throttled read (still pending, logged), a missing row or status;
* the OUTPUTS of a finished wait: ``status`` always, ``items_found`` only when the row has one (``0``
  included), as a string;
* the BOUNDARIES of ``timeout_minutes`` (``0`` and ``1``, a bool, a string) and of a reference (ASCII
  digits only, whole string only).
"""
from __future__ import annotations

import dataclasses
import typing
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError, EndpointConnectionError

from agents import plan_waits
from agents.plan_waits import WaitResult, poll, resolve_value, timeout_minutes


@dataclasses.dataclass
class Tables:
    aggregates: MagicMock
    jobs: MagicMock
    logger: MagicMock


def _table(item: object = None) -> MagicMock:
    table = MagicMock()
    table.get_item.return_value = {} if item is None else {'Item': item}
    return table


def _rows(env: Tables, item: dict) -> None:
    """Both tables answer ``item``: the kind under test decides which one is read."""
    for table in (env.aggregates, env.jobs):
        table.get_item.return_value = {'Item': item}


@pytest.fixture
def tables() -> Iterator[Tables]:
    env = Tables(_table(), _table(), MagicMock())
    with patch.object(plan_waits, 'get_aggregates_table', return_value=env.aggregates), \
            patch.object(plan_waits, 'get_jobs_table', return_value=env.jobs), \
            patch.object(plan_waits, 'logger', env.logger):
        yield env


SOURCE_WAIT = {'for': 'source_run', 'source': 'app_reviews', 'execution_id': 'ex-1'}
SCRAPER_WAIT = {'for': 'scraper_run', 'scraper_id': 'sc_9', 'execution_id': 'ex-2'}
JOB_WAIT = {'for': 'project_job', 'project_id': 'proj_1', 'job_id': 'job_7'}


class TestEachKindReadsItsOwnRow:
    @pytest.mark.parametrize(('wait', 'table', 'key'), [
        (SOURCE_WAIT, 'aggregates', {'pk': 'SOURCE_RUN#app_reviews', 'sk': 'ex-1'}),
        (SCRAPER_WAIT, 'aggregates', {'pk': 'SCRAPER_RUN#sc_9', 'sk': 'ex-2'}),
        (JOB_WAIT, 'jobs', {'pk': 'PROJECT#proj_1', 'sk': 'JOB#job_7'}),
    ])
    def test_the_key_and_table(self, tables: Tables, wait: dict, table: str, key: dict):
        assert poll(wait, {}) == WaitResult('pending')
        used, unused = (tables.aggregates, tables.jobs) if table == 'aggregates' else (tables.jobs, tables.aggregates)
        used.get_item.assert_called_once_with(Key=key, ConsistentRead=True)
        unused.get_item.assert_not_called()

    def test_references_are_resolved_into_the_key(self, tables: Tables):
        wait = {'for': 'project_job', 'project_id': '{{s1.project_id}}', 'job_id': '{{s12.job_id}}'}
        poll(wait, {'s1.project_id': 'proj_2', 's12.job_id': 'job_3'})
        tables.jobs.get_item.assert_called_once_with(Key={'pk': 'PROJECT#proj_2', 'sk': 'JOB#job_3'},
                                                     ConsistentRead=True)

    def test_a_non_string_id_is_formatted_as_is(self, tables: Tables):
        poll({'for': 'source_run', 'source': 7, 'execution_id': None}, {})
        tables.aggregates.get_item.assert_called_once_with(Key={'pk': 'SOURCE_RUN#7', 'sk': 'None'},
                                                           ConsistentRead=True)


class TestEveryEndingNamesItsCause:
    @pytest.mark.parametrize(('wait', 'status'), [
        (SOURCE_WAIT, 'completed'),
        (SCRAPER_WAIT, 'completed'),
        (SCRAPER_WAIT, 'completed_with_errors'),
        (JOB_WAIT, 'completed'),
    ])
    def test_done_statuses(self, tables: Tables, wait: dict, status: str):
        _rows(tables, {'status': status})
        assert poll(wait, {}) == WaitResult('done', {'status': status}, None)

    @pytest.mark.parametrize(('wait', 'status', 'error'), [
        (SOURCE_WAIT, 'error', 'The import failed.'),
        (SCRAPER_WAIT, 'error', 'The scraper run failed.'),
        (JOB_WAIT, 'failed', 'The project job failed.'),
    ])
    def test_failed_statuses(self, tables: Tables, wait: dict, status: str, error: str):
        _rows(tables, {'status': status})
        assert poll(wait, {}) == WaitResult('failed', {}, error)

    @pytest.mark.parametrize(('wait', 'status'), [
        (SOURCE_WAIT, 'completed_with_errors'),
        (SOURCE_WAIT, 'failed'),
        (SOURCE_WAIT, 'running'),
        (JOB_WAIT, 'error'),
        (JOB_WAIT, 'completed_with_errors'),
        (SCRAPER_WAIT, 'failed'),
    ])
    def test_another_kinds_status_is_still_pending(self, tables: Tables, wait: dict, status: str):
        _rows(tables, {'status': status})
        assert poll(wait, {}) == WaitResult('pending', {}, None)

    @pytest.mark.parametrize('response', [{}, {'Item': None}, {'Item': ['completed']}, {'Item': {}},
                                          {'Item': {'status': None}}])
    def test_a_missing_row_or_status_is_pending(self, tables: Tables, response: dict):
        tables.aggregates.get_item.return_value = response
        assert poll(SOURCE_WAIT, {}) == WaitResult('pending', {}, None)

    @pytest.mark.parametrize('kind', [None, 'nope', 'SOURCE_RUN'])
    def test_an_unknown_kind_fails_without_a_read(self, tables: Tables, kind: Any):
        assert poll({'for': kind}, {}) == WaitResult('failed', {}, 'The step waits for an unknown kind of job.')
        tables.aggregates.get_item.assert_not_called()
        tables.jobs.get_item.assert_not_called()

    def test_an_unrecorded_reference_fails_without_a_read(self, tables: Tables):
        wait = {**SOURCE_WAIT, 'execution_id': '{{s2.execution_id}}'}
        assert poll(wait, {'s1.execution_id': 'x'}) == WaitResult(
            'failed', {}, 'The output s2.execution_id was not recorded.')
        tables.aggregates.get_item.assert_not_called()

    @pytest.mark.parametrize('exc', [
        ClientError({'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'slow'}}, 'GetItem'),
        EndpointConnectionError(endpoint_url='https://dynamodb'),
    ])
    def test_a_failed_read_is_pending_and_logged(self, tables: Tables, exc: Exception):
        tables.jobs.get_item.side_effect = exc
        assert poll(JOB_WAIT, {}) == WaitResult('pending', {}, None)
        tables.logger.warning.assert_called_once_with('Plan wait poll failed; trying again next time',
                                                      extra={'wait_for': 'project_job'})

    def test_another_error_propagates(self, tables: Tables):
        tables.jobs.get_item.side_effect = ValueError('boom')
        with pytest.raises(ValueError, match=r'^boom$'):
            poll(JOB_WAIT, {})

    @pytest.mark.parametrize(('getter', 'wait', 'message'), [
        ('get_aggregates_table', SOURCE_WAIT, '^aggregates table is not configured$'),
        ('get_jobs_table', JOB_WAIT, '^jobs table is not configured$'),
    ])
    @pytest.mark.usefixtures('tables')
    def test_an_unconfigured_table_raises(self, getter: str, wait: dict, message: str):
        with patch.object(plan_waits, getter, return_value=None), pytest.raises(RuntimeError, match=message):
            poll(wait, {})


class TestDoneOutputs:
    @pytest.mark.parametrize(('found', 'outputs'), [
        (12, {'status': 'completed', 'items_found': '12'}),
        (0, {'status': 'completed', 'items_found': '0'}),
        ('', {'status': 'completed', 'items_found': ''}),
        (None, {'status': 'completed'}),
    ])
    def test_items_found_only_when_present(self, tables: Tables, found: object, outputs: dict):
        tables.aggregates.get_item.return_value = {'Item': {'status': 'completed', 'items_found': found}}
        assert poll(SOURCE_WAIT, {}) == WaitResult('done', outputs, None)


class TestResolveValue:
    @pytest.mark.parametrize('value', [5, None, ['{{s1.out}}'], 'literal', '{{s1.out}} ', 'x{{s1.out}}',
                                       '{{s\u0661.out}}', '{{s1.Out}}'])
    def test_anything_but_a_whole_ascii_reference_is_returned_unchanged(self, value: object):
        assert resolve_value(value, {}) is value

    def test_a_reference_is_replaced_by_the_recorded_output(self):
        assert resolve_value('{{s3.items_found}}', {'s3.items_found': '4'}) == '4'

    def test_an_unrecorded_reference_names_its_key(self):
        with pytest.raises(plan_waits.UnresolvedReference) as caught:
            resolve_value('{{s3.items_found}}', {'s3.status': 'completed'})
        assert caught.value.args == ('s3.items_found',)


class TestTimeoutMinutes:
    @pytest.mark.parametrize(('wait', 'minutes'), [
        ({}, 60), ({'timeout_minutes': 0}, 60), ({'timeout_minutes': -5}, 60), ({'timeout_minutes': 1}, 1),
        ({'timeout_minutes': 1440}, 1440), ({'timeout_minutes': True}, 60), ({'timeout_minutes': '30'}, 60),
        ({'timeout_minutes': 30.0}, 60),
    ])
    def test_a_positive_int_or_the_default(self, wait: dict, minutes: int):
        assert timeout_minutes(wait) == minutes


class TestValues:
    def test_the_status_words(self):
        assert (plan_waits.WAIT_PENDING, plan_waits.WAIT_DONE, plan_waits.WAIT_FAILED) == ('pending', 'done', 'failed')
        assert plan_waits.DEFAULT_TIMEOUT_MINUTES == 60

    def test_a_wait_result_defaults_and_is_frozen(self):
        result = WaitResult('pending')
        assert (result.outputs, result.error) == ({}, None)
        untyped: Any = result
        with pytest.raises(dataclasses.FrozenInstanceError):
            untyped.status = 'done'

    def test_a_wait_result_declares_its_field_types(self):
        assert typing.get_type_hints(WaitResult) == {'status': str, 'outputs': dict[str, str], 'error': str | None}

    def test_the_shared_target_table_cannot_be_changed_at_runtime(self):
        target: Any = plan_waits._TARGETS['source_run']
        with pytest.raises(dataclasses.FrozenInstanceError):
            target.failure = 'changed'
