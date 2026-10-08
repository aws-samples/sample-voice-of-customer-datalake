"""Mutation hardening for `agents/store.py`.

`test_conductor_run.py` drives the store through whole runs and `test_runtime_units.py`
round-trips `plain` / `dynamo_value` / `max_calls_for` on one value each, so between
them they pin that a run starts, finishes and journals. A mutation run found the
contract itself unobserved:

* the ROW SHAPES the agents API reads back — ``RUN#`` / ``EVT#{seq:08d}`` /
  ``MATE#{role}#{seq:06d}`` keys, ``gsi1pk = RUNS_ACTIVE`` while running and
  removed on finish, ``started_at`` / ``finished_at`` stamped once, the counters
  seeded with ``if_not_exists``, the ``error`` attribute written only when there is
  one and clipped to exactly 500 characters, ``summary`` to 500, ``text`` to 8,000;
* every REFUSAL and its wording — ``run is not queued``, ``run left running``,
  ``not a terminal status: …``, ``unknown event kind: …``, ``counter attribute is not
  a number: bool``, ``model-call budget exhausted or run not running``,
  ``AGENTS_TABLE is not configured`` — and that a non-conditional DynamoDB error is
  never swallowed by the handlers that swallow a failed condition;
* the BOUNDS: a budget of 2 admits exactly 2 reservations, ``max_model_calls_per_run``
  accepts 1 and 1000 and refuses 0 and 1001, a workflow pointer whose revision is 0
  does not count as pinned, and ``list_events`` honours ``limit`` and ignores the
  transcript rows sharing the partition;
* the SIDE EFFECTS of a finished run on the agent row: the lock released and the
  ``runs_<status>`` counter bumped through ``shared.agents_store``, ``last_run_*``
  stamped with the same ``finished_at``, and ``month_calls`` bumped by exactly 1 per
  reserved model call;
* the reads: ``ConsistentRead=True`` on every agent / run / workflow ``get_item``.

Every expectation here is the literal string, number, key or call the module emits.
"""
from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from moto import mock_aws

from agents import store
from agents.test.conftest import AGENT_ID, RUN_ID, _create_table, partition, run_row, seed_agent, seed_run

RUN_KEY = {'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}'}
AGENT_KEY = {'pk': f'AGENT#{AGENT_ID}', 'sk': 'META'}
DEFINITION = {'nodes': [{'id': 'n1', 'type': 'aggregate_reviews'}], 'edges': []}
NO_TEXT: Any = None  # a caller that passes no summary / text at all (the runtime's optional fields)


@pytest.fixture(scope='module')
def _agents_table():
    """One moto ``voc-agents`` table for the module (creating one per test dominates the run)."""
    import shared.aws
    with mock_aws():
        shared.aws._dynamodb_resource = None
        yield _create_table(os.environ['AGENTS_TABLE'])
    shared.aws._dynamodb_resource = None


@pytest.fixture
def agents(_agents_table):
    """The module's table, emptied before each test."""
    items = _agents_table.scan(ProjectionExpression='pk, sk')['Items']
    with _agents_table.batch_writer() as batch:
        for item in items:
            batch.delete_item(Key={'pk': item['pk'], 'sk': item['sk']})
    return _agents_table


def _conditional_failure() -> ClientError:
    return ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'no'}}, 'UpdateItem')


def _mock_table(**methods: Any) -> MagicMock:
    table = MagicMock()
    for name, value in methods.items():
        getattr(table, name).side_effect = value
    return table


@contextmanager
def _update_item_raising_boom() -> Iterator[None]:
    """A table whose ``update_item`` raises a NON-conditional error, around a call that must let it through.

    The writers swallow only ``ConditionalCheckFailedException``; anything else has to reach the caller
    unchanged, so the block fails unless exactly ``RuntimeError('boom')`` escapes it.
    """
    table = _mock_table(update_item=RuntimeError('boom'))
    with patch.object(store, '_table', return_value=table), pytest.raises(RuntimeError, match=r'^boom$'):
        yield


def _agent_row(table) -> dict:
    return table.get_item(Key=AGENT_KEY)['Item']


def _parse_iso(value: Any) -> datetime:
    assert isinstance(value, str)
    return datetime.fromisoformat(value)


class TestConstants:
    def test_the_status_vocabulary(self):
        assert (store.RUN_QUEUED, store.RUN_RUNNING, store.RUN_NEEDS_HUMAN, store.RUN_COMPLETED,
                store.RUN_FAILED, store.RUN_CANCELLED) == (
            'queued', 'running', 'needs_human', 'completed', 'failed', 'cancelled')
        assert set(store.TERMINAL_STATUSES) == {'needs_human', 'completed', 'failed', 'cancelled'}
        assert store.RUNS_ACTIVE_GSI_PK == 'RUNS_ACTIVE'

    def test_the_event_kinds_and_the_clips(self):
        assert set(store.EVENT_KINDS) == {
            'node_started', 'node_finished', 'node_failed', 'message', 'verdict', 'decision', 'artifact'}
        assert store.MAX_EVENT_SUMMARY_CHARS == 500
        assert store.MAX_MATE_TEXT_CHARS == 8000
        assert store.DEFAULT_MAX_MODEL_CALLS_PER_RUN == 150


class TestNowIso:
    def test_is_an_aware_utc_timestamp_of_now(self):
        before = datetime.now(UTC)
        stamp = _parse_iso(store.now_iso())
        assert stamp.utcoffset() == timedelta(0)
        assert timedelta(0) <= stamp - before < timedelta(seconds=5)


class TestPlain:
    @pytest.mark.parametrize(('value', 'expected'), [
        (Decimal('2'), 2), (Decimal('1.5'), 1.5), (Decimal('-3'), -3), (Decimal('0.25'), 0.25),
        ({1: Decimal('1')}, {'1': 1}), ((Decimal('1'), 'a'), [1, 'a']), ({Decimal('7')}, [7]),
        ([{'n': (Decimal('2.5'),)}], [{'n': [2.5]}]), ('text', 'text'), (None, None), (True, True),
    ])
    def test_values(self, value, expected):
        result = store.plain(value)
        assert result == expected
        assert type(result) is type(expected)

    def test_a_whole_number_decimal_becomes_an_int_not_a_float(self):
        assert type(store.plain(Decimal('2'))) is int
        assert type(store.plain(Decimal('2.0'))) is int
        assert type(store.plain(Decimal('2.5'))) is float


class TestDynamoValue:
    @pytest.mark.parametrize(('value', 'expected'), [
        (0.1, Decimal('0.1')), (4.5, Decimal('4.5')), (True, True), (False, False), (3, 3),
        ({1: 0.5}, {'1': Decimal('0.5')}), ((1.5, 'a'), [Decimal('1.5'), 'a']), ([[0.1]], [[Decimal('0.1')]]),
        ('text', 'text'), (None, None),
    ])
    def test_values(self, value, expected):
        result = store.dynamo_value(value)
        assert result == expected
        assert type(result) is type(expected)

    def test_a_float_is_converted_through_its_repr_not_its_binary_value(self):
        assert store.dynamo_value(0.1) == Decimal('0.1')
        assert str(store.dynamo_value(0.1)) == '0.1'  # not the binary expansion 0.1000000000000000055…

    def test_bools_are_not_decimals(self):
        assert store.dynamo_value(True) is True
        assert store.dynamo_value({'ok': False}) == {'ok': False}


class TestTable:
    @pytest.mark.parametrize('configured', ['', None])
    def test_refuses_without_the_table_name(self, monkeypatch, configured):
        if configured is None:
            monkeypatch.delenv('AGENTS_TABLE')
        else:
            monkeypatch.setenv('AGENTS_TABLE', configured)
        with pytest.raises(RuntimeError, match=r'^AGENTS_TABLE is not configured$'):
            store._table()

    @pytest.mark.usefixtures('agents')
    def test_opens_the_configured_table(self, monkeypatch):
        monkeypatch.setenv('AGENTS_TABLE', 'test-agents')
        assert store._table().name == 'test-agents'


class TestRunKey:
    def test_shape(self):
        assert store._run_key('ag_9', 'ar_7') == {'pk': 'AGENT#ag_9', 'sk': 'RUN#ar_7'}


class TestConsistentReads:
    def test_get_agent_reads_meta_consistently(self):
        table = _mock_table(get_item=[{'Item': {'agent_id': 'ag_9', 'n': Decimal('1')}}])
        with patch.object(store, '_table', return_value=table):
            assert store.get_agent('ag_9') == {'agent_id': 'ag_9', 'n': 1}
        table.get_item.assert_called_once_with(Key={'pk': 'AGENT#ag_9', 'sk': 'META'}, ConsistentRead=True)

    def test_get_run_reads_the_run_row_consistently(self):
        table = _mock_table(get_item=[{'Item': {'run_id': 'ar_7', 'steps': Decimal('3')}}])
        with patch.object(store, '_table', return_value=table):
            assert store.get_run('ag_9', 'ar_7') == {'run_id': 'ar_7', 'steps': 3}
        table.get_item.assert_called_once_with(Key={'pk': 'AGENT#ag_9', 'sk': 'RUN#ar_7'}, ConsistentRead=True)

    @pytest.mark.parametrize('response', [{}, {'Item': 'not-a-dict'}, {'Item': None}])
    def test_missing_rows_are_none(self, response):
        table = _mock_table(get_item=[response, response])
        with patch.object(store, '_table', return_value=table):
            assert store.get_agent('ag_9') is None
            assert store.get_run('ag_9', 'ar_7') is None

    def test_load_workflow_reads_the_pointer_then_the_revision_consistently(self):
        table = _mock_table(get_item=[
            {'Item': {'revision': Decimal('2')}},
            {'Item': {'definition': json.dumps(DEFINITION)}},
        ])
        with patch.object(store, '_table', return_value=table):
            assert store.load_workflow('wf_1') == (DEFINITION, 2)
        assert table.get_item.call_args_list == [
            ({'Key': {'pk': 'WORKFLOW#wf_1', 'sk': 'CURRENT'}, 'ConsistentRead': True},),
            ({'Key': {'pk': 'WORKFLOW#wf_1', 'sk': 'REV#000002'}, 'ConsistentRead': True},),
        ]

    def test_load_workflow_with_a_pinned_revision_skips_the_pointer(self):
        table = _mock_table(get_item=[{'Item': {'definition': DEFINITION}}])
        with patch.object(store, '_table', return_value=table):
            assert store.load_workflow('wf_1', 12) == (DEFINITION, 12)
        table.get_item.assert_called_once_with(Key={'pk': 'WORKFLOW#wf_1', 'sk': 'REV#000012'}, ConsistentRead=True)


class TestGetAgentAndRun:
    def test_rows_come_back_plain(self, agents):
        seed_agent(agents, budget={'max_model_calls_per_run': Decimal('7')})
        seed_run(agents)
        agent = store.get_agent(AGENT_ID)
        run = store.get_run(AGENT_ID, RUN_ID)
        assert agent is not None
        assert agent['budget'] == {'max_model_calls_per_run': 7}
        assert type(agent['budget']['max_model_calls_per_run']) is int
        assert run == {'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}', 'run_id': RUN_ID, 'agent_id': AGENT_ID,
                       'status': 'queued', 'trigger': 'manual', 'model_calls': 0}

    def test_missing_rows_are_none(self, agents):
        assert 'Item' not in agents.get_item(Key=AGENT_KEY)
        assert store.get_agent(AGENT_ID) is None
        assert store.get_run(AGENT_ID, RUN_ID) is None


class TestDefinitionOf:
    @pytest.mark.parametrize(('item', 'expected'), [
        (None, None), ('row', None), ({}, None), ({'definition': None}, None),
        ({'definition': 'not json'}, None), ({'definition': '[1]'}, None), ({'definition': ['n']}, None),
        ({'definition': '{"a": 1}'}, {'a': 1}),
        ({'definition': {'a': Decimal('1'), 'b': {'c': Decimal('2.5')}}}, {'a': 1, 'b': {'c': 2.5}}),
    ])
    def test_values(self, item, expected):
        assert store._definition_of(item) == expected


class TestLoadWorkflow:
    def _pointer(self, table, **attrs: Any) -> None:
        table.put_item(Item={'pk': 'WORKFLOW#wf_1', 'sk': 'CURRENT', **attrs})

    def _revision(self, table, revision: int, definition: Any) -> None:
        table.put_item(Item={'pk': 'WORKFLOW#wf_1', 'sk': f'REV#{revision:06d}', 'definition': definition})

    @pytest.mark.usefixtures('agents')
    def test_no_pointer_is_none(self):
        assert store.load_workflow('wf_1') is None

    def test_an_inline_definition_on_the_pointer_is_used_without_a_revision_read(self, agents):
        self._pointer(agents, revision=3, definition=json.dumps(DEFINITION))
        self._revision(agents, 3, {'nodes': ['stale'], 'edges': []})
        assert store.load_workflow('wf_1') == (DEFINITION, 3)

    def test_a_pointer_without_a_definition_reads_its_revision_row(self, agents):
        self._pointer(agents, revision=2)
        self._revision(agents, 2, json.dumps(DEFINITION))
        self._revision(agents, 1, json.dumps({'nodes': ['old'], 'edges': []}))
        assert store.load_workflow('wf_1') == (DEFINITION, 2)

    def test_a_revision_of_zero_does_not_count_as_pinned(self, agents):
        self._pointer(agents, revision=0, definition=json.dumps(DEFINITION))
        assert store.load_workflow('wf_1') is None
        self._revision(agents, 0, DEFINITION)
        assert store.load_workflow('wf_1') == (DEFINITION, 0)

    def test_a_pointer_with_no_revision_attribute_means_revision_zero(self, agents):
        self._pointer(agents, definition=json.dumps(DEFINITION))
        self._revision(agents, 0, DEFINITION)
        assert store.load_workflow('wf_1') == (DEFINITION, 0)

    def test_an_unreadable_definition_is_none(self, agents):
        self._pointer(agents, revision=4, definition='{broken')
        self._revision(agents, 4, '[1, 2]')
        assert store.load_workflow('wf_1') is None

    def test_a_pinned_revision_wins_over_the_pointer(self, agents):
        self._pointer(agents, revision=5, definition=json.dumps({'nodes': ['current'], 'edges': []}))
        self._revision(agents, 2, DEFINITION)
        assert store.load_workflow('wf_1', 2) == (DEFINITION, 2)
        assert store.load_workflow('wf_1', 9) is None


class TestStartRun:
    def test_queued_becomes_running_with_the_runtime_attributes(self, agents):
        seed_run(agents)
        before = datetime.now(UTC)
        returned = store.start_run(AGENT_ID, RUN_ID, 3)
        row = store.plain(run_row(agents))
        assert returned == row
        started = _parse_iso(row['started_at'])
        assert timedelta(0) <= started - before < timedelta(seconds=5)
        assert row == {
            'pk': f'AGENT#{AGENT_ID}', 'sk': f'RUN#{RUN_ID}', 'run_id': RUN_ID, 'agent_id': AGENT_ID,
            'trigger': 'manual', 'status': 'running', 'started_at': row['started_at'],
            'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': row['started_at'], 'workflow_revision': 3,
            'context': {}, 'loop_rounds': {}, 'steps': 0, 'model_calls': 0,
        }

    def test_a_redriven_running_run_keeps_its_progress(self, agents):
        agents.put_item(Item={**RUN_KEY, 'status': 'running', 'started_at': '2026-01-01T00:00:00+00:00',
                              'context': {'n1': 'done'}, 'loop_rounds': {'n2': 1}, 'steps': 4, 'model_calls': 6,
                              'workflow_revision': 1})
        returned = store.start_run(AGENT_ID, RUN_ID, 2)
        assert returned['started_at'] == '2026-01-01T00:00:00+00:00'
        assert returned['gsi1sk'] != '2026-01-01T00:00:00+00:00'
        assert (returned['context'], returned['loop_rounds'], returned['steps'], returned['model_calls']) == (
            {'n1': 'done'}, {'n2': 1}, 4, 6)
        assert returned['workflow_revision'] == 2
        assert returned['status'] == 'running'

    @pytest.mark.parametrize('status', ['completed', 'failed', 'cancelled', 'needs_human'])
    def test_a_finished_run_is_refused(self, agents, status):
        seed_run(agents, status)
        with pytest.raises(store.RunNotRunning, match=r'^run is not queued$'):
            store.start_run(AGENT_ID, RUN_ID, 1)
        assert run_row(agents)['status'] == status

    @pytest.mark.usefixtures('agents')
    def test_a_missing_run_is_refused(self):
        with pytest.raises(store.RunNotRunning, match=r'^run is not queued$'):
            store.start_run(AGENT_ID, RUN_ID, 1)

    def test_other_errors_propagate(self):
        with _update_item_raising_boom():
            store.start_run(AGENT_ID, RUN_ID, 1)


class TestUpdateRunning:
    def test_sets_every_attribute_with_dynamo_safe_values(self, agents):
        seed_run(agents, 'running')
        store.update_running(AGENT_ID, RUN_ID, {'steps': 3, 'context': {'score': 4.5, 'ok': True}, 'poll_attempts': 1})
        row = run_row(agents)
        assert row['steps'] == Decimal('3')
        assert row['context'] == {'score': Decimal('4.5'), 'ok': True}
        assert row['poll_attempts'] == Decimal('1')
        assert row['status'] == 'running'

    def test_an_empty_set_touches_nothing(self):
        table = MagicMock()
        with patch.object(store, '_table', return_value=table):
            assert store.update_running(AGENT_ID, RUN_ID, {}) is None
        table.update_item.assert_not_called()

    @pytest.mark.parametrize('status', ['queued', 'cancelled', 'completed'])
    def test_a_run_that_left_running_is_refused_untouched(self, agents, status):
        seed_run(agents, status)
        with pytest.raises(store.RunNotRunning, match=r'^run left running$'):
            store.update_running(AGENT_ID, RUN_ID, {'steps': 1})
        assert 'steps' not in run_row(agents)

    def test_other_errors_propagate(self):
        with _update_item_raising_boom():
            store.update_running(AGENT_ID, RUN_ID, {'steps': 1})


class TestFinishRun:
    def _running(self, agents) -> None:
        seed_agent(agents, active_run_id=RUN_ID)
        agents.put_item(Item={**RUN_KEY, 'status': 'running', 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'})

    @pytest.mark.parametrize('status', ['queued', 'running', 'done', ''])
    def test_a_non_terminal_status_is_refused_before_any_write(self, status):
        table = MagicMock()
        with patch.object(store, '_table', return_value=table), \
                pytest.raises(ValueError, match=rf'^not a terminal status: {status}$'):
            store.finish_run(AGENT_ID, RUN_ID, status)
        table.update_item.assert_not_called()

    @pytest.mark.parametrize('status', ['needs_human', 'completed', 'failed', 'cancelled'])
    def test_running_becomes_terminal_and_leaves_the_active_index(self, agents, status):
        self._running(agents)
        assert store.finish_run(AGENT_ID, RUN_ID, status) is True
        row = run_row(agents)
        assert row == {**RUN_KEY, 'status': status, 'finished_at': row['finished_at']}
        assert _parse_iso(row['finished_at']).utcoffset() == timedelta(0)

    def test_an_error_is_stored_clipped_to_500_characters(self, agents):
        self._running(agents)
        assert store.finish_run(AGENT_ID, RUN_ID, 'failed', 'e' * 499 + 'X' + 'tail') is True
        row = run_row(agents)
        assert row['error'] == 'e' * 499 + 'X'
        assert len(row['error']) == 500

    def test_a_short_error_is_stored_whole_and_an_empty_one_not_at_all(self, agents):
        self._running(agents)
        assert store.finish_run(AGENT_ID, RUN_ID, 'failed', 'node n1 failed') is True
        assert run_row(agents)['error'] == 'node n1 failed'
        agents.put_item(Item={**RUN_KEY, 'status': 'running'})
        seed_agent(agents, active_run_id=RUN_ID)
        assert store.finish_run(AGENT_ID, RUN_ID, 'failed', '') is True
        assert 'error' not in run_row(agents)

    def test_releases_the_lock_counts_the_status_and_stamps_the_agent(self, agents):
        self._running(agents)
        assert store.finish_run(AGENT_ID, RUN_ID, 'completed') is True
        agent = _agent_row(agents)
        finished_at = run_row(agents)['finished_at']
        assert 'active_run_id' not in agent
        assert agent['runs_completed'] == Decimal('1')
        assert (agent['last_run_id'], agent['last_run_status'], agent['last_run_finished_at']) == (
            RUN_ID, 'completed', finished_at)

    def test_release_lock_is_called_with_the_terminal_status(self, agents):
        self._running(agents)
        with patch.object(store.shared_store, 'release_lock') as release:
            assert store.finish_run(AGENT_ID, RUN_ID, 'needs_human') is True
        release.assert_called_once()
        table, agent_id, run_id, status = release.call_args.args
        assert (table.name, agent_id, run_id, status) == ('test-agents', AGENT_ID, RUN_ID, 'needs_human')

    @pytest.mark.parametrize('status', ['queued', 'completed', 'cancelled'])
    def test_a_run_that_already_left_running_is_left_alone(self, agents, status):
        seed_agent(agents, active_run_id=RUN_ID)
        agents.put_item(Item={**RUN_KEY, 'status': status, 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'})
        with patch.object(store.shared_store, 'release_lock') as release:
            assert store.finish_run(AGENT_ID, RUN_ID, 'failed', 'late') is False
        release.assert_not_called()
        assert run_row(agents) == {**RUN_KEY, 'status': status, 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'}
        assert _agent_row(agents)['active_run_id'] == RUN_ID
        assert 'last_run_id' not in _agent_row(agents)

    @pytest.mark.usefixtures('agents')
    def test_a_missing_run_is_false(self):
        assert store.finish_run(AGENT_ID, RUN_ID, 'failed', 'gone') is False

    def test_other_errors_propagate(self):
        with _update_item_raising_boom():
            store.finish_run(AGENT_ID, RUN_ID, 'failed')


class TestMarkCancelledFinished:
    def test_stamps_finished_at_once_and_leaves_the_active_index(self, agents):
        agents.put_item(Item={**RUN_KEY, 'status': 'cancelled', 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'})
        store.mark_cancelled_finished(AGENT_ID, RUN_ID)
        row = run_row(agents)
        assert row == {**RUN_KEY, 'status': 'cancelled', 'finished_at': row['finished_at']}
        assert _parse_iso(row['finished_at']).utcoffset() == timedelta(0)
        store.mark_cancelled_finished(AGENT_ID, RUN_ID)
        assert run_row(agents) == row

    @pytest.mark.parametrize('status', ['running', 'completed', 'queued'])
    def test_any_other_status_is_left_untouched_without_raising(self, agents, status):
        agents.put_item(Item={**RUN_KEY, 'status': status, 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'})
        assert store.mark_cancelled_finished(AGENT_ID, RUN_ID) is None
        assert run_row(agents) == {**RUN_KEY, 'status': status, 'gsi1pk': 'RUNS_ACTIVE', 'gsi1sk': 'x'}

    @pytest.mark.usefixtures('agents')
    def test_a_missing_run_does_not_raise(self):
        assert store.mark_cancelled_finished(AGENT_ID, RUN_ID) is None

    def test_other_errors_propagate(self):
        with _update_item_raising_boom():
            store.mark_cancelled_finished(AGENT_ID, RUN_ID)


class TestRecordLastRun:
    def test_stamps_an_existing_agent(self, agents):
        seed_agent(agents)
        store._record_last_run(AGENT_ID, RUN_ID, 'failed', '2026-02-01T00:00:00+00:00')
        agent = _agent_row(agents)
        assert (agent['last_run_id'], agent['last_run_status'], agent['last_run_finished_at']) == (
            RUN_ID, 'failed', '2026-02-01T00:00:00+00:00')
        assert agent['name'] == 'Checkout agent'

    def test_a_missing_agent_is_not_created(self, agents):
        assert store._record_last_run(AGENT_ID, RUN_ID, 'failed', 'now') is None
        assert 'Item' not in agents.get_item(Key=AGENT_KEY)

    def test_other_errors_propagate(self):
        with _update_item_raising_boom():
            store._record_last_run(AGENT_ID, RUN_ID, 'failed', 'now')


class TestCounterValue:
    @pytest.mark.parametrize(('value', 'expected'), [(Decimal('3'), 3), (4, 4), (Decimal('0'), 0)])
    def test_numbers_become_ints(self, value, expected):
        result = store._counter_value(value)
        assert result == expected
        assert type(result) is int

    @pytest.mark.parametrize(('value', 'name'), [(True, 'bool'), (False, 'bool'), ('3', 'str'), (None, 'NoneType'),
                                                 (2.5, 'float')])
    def test_anything_else_is_refused_by_type_name(self, value, name):
        with pytest.raises(TypeError, match=rf'^counter attribute is not a number: {name}$'):
            store._counter_value(value)


class TestNextSeq:
    def test_counts_from_one_per_counter(self, agents):
        seed_run(agents, 'running')
        assert [store._next_seq(AGENT_ID, RUN_ID, 'event_seq') for _ in range(3)] == [1, 2, 3]
        assert store._next_seq(AGENT_ID, RUN_ID, 'mate_seq') == 1
        row = run_row(agents)
        assert (row['event_seq'], row['mate_seq']) == (Decimal('3'), Decimal('1'))

    def test_returns_an_int(self, agents):
        seed_run(agents, 'running')
        assert type(store._next_seq(AGENT_ID, RUN_ID, 'event_seq')) is int

    def test_a_missing_run_is_not_created(self, agents):
        with pytest.raises(ClientError) as info:
            store._next_seq(AGENT_ID, RUN_ID, 'event_seq')
        assert info.value.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException'
        assert 'Item' not in agents.get_item(Key=RUN_KEY)


class TestAppendEvent:
    @pytest.mark.parametrize('kind', ['', 'node_start', 'unknown'])
    def test_an_unknown_kind_is_refused_before_any_write(self, kind):
        table = MagicMock()
        with patch.object(store, '_table', return_value=table), \
                pytest.raises(ValueError, match=rf'^unknown event kind: {kind}$'):
            store.append_event(AGENT_ID, RUN_ID, kind, 'x')
        table.update_item.assert_not_called()
        table.put_item.assert_not_called()

    def test_the_minimal_row(self, agents):
        seed_run(agents, 'running')
        before = datetime.now(UTC)
        assert store.append_event(AGENT_ID, RUN_ID, 'message', 'hello') == 1
        [row] = partition(agents, 'EVT#')
        assert timedelta(0) <= _parse_iso(row['at']) - before < timedelta(seconds=5)
        assert row == {'pk': f'RUN#{RUN_ID}', 'sk': 'EVT#00000001', 'seq': Decimal('1'), 'at': row['at'],
                       'kind': 'message', 'summary': 'hello'}

    def test_the_full_row_keeps_only_non_empty_string_refs(self, agents):
        seed_run(agents, 'running')
        seq = store.append_event(AGENT_ID, RUN_ID, 'artifact', 's', node_id='n1', role='builder',
                                 ref={'project_id': 'p1', 'document_id': '', 'count': 3, 'job': None})
        assert seq == 1
        [row] = partition(agents, 'EVT#')
        assert row['node_id'] == 'n1'
        assert row['role'] == 'builder'
        assert row['ref'] == {'project_id': 'p1'}

    def test_empty_optionals_are_not_written(self, agents):
        seed_run(agents, 'running')
        store.append_event(AGENT_ID, RUN_ID, 'decision', 's', node_id='', role=None, ref={'x': '', 'y': 1})
        [row] = partition(agents, 'EVT#')
        assert set(row) == {'pk', 'sk', 'seq', 'at', 'kind', 'summary'}

    def test_summaries_are_clipped_to_500_and_none_becomes_empty(self, agents):
        seed_run(agents, 'running')
        store.append_event(AGENT_ID, RUN_ID, 'verdict', 's' * 500 + 'X')
        store.append_event(AGENT_ID, RUN_ID, 'verdict', NO_TEXT)
        long_row, empty_row = partition(agents, 'EVT#')
        assert long_row['summary'] == 's' * 500
        assert empty_row['summary'] == ''

    def test_sequences_are_zero_padded_to_eight_digits_and_increase(self, agents):
        seed_run(agents, 'running')
        assert [store.append_event(AGENT_ID, RUN_ID, 'node_started', 'x') for _ in range(3)] == [1, 2, 3]
        assert [row['sk'] for row in partition(agents, 'EVT#')] == ['EVT#00000001', 'EVT#00000002', 'EVT#00000003']

    def test_the_counter_lives_in_event_seq_on_the_run_row(self, agents):
        seed_run(agents, 'running')
        store.append_event(AGENT_ID, RUN_ID, 'node_started', 'x')
        row = run_row(agents)
        assert row['event_seq'] == Decimal('1')
        assert 'mate_seq' not in row


class TestListEvents:
    def test_oldest_first_plain_and_bounded_by_limit(self, agents):
        seed_run(agents, 'running')
        for n in range(3):
            store.append_event(AGENT_ID, RUN_ID, 'message', f'm{n}')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n1', 'to_mate', 'ignored')
        events = store.list_events(RUN_ID, 10)
        assert [(e['seq'], e['summary']) for e in events] == [(1, 'm0'), (2, 'm1'), (3, 'm2')]
        assert all(type(e['seq']) is int for e in events)
        assert [e['summary'] for e in store.list_events(RUN_ID, 2)] == ['m0', 'm1']

    @pytest.mark.usefixtures('agents')
    def test_an_unknown_run_is_empty(self):
        assert store.list_events('ar_nobody', 5) == []


class TestAppendMate:
    def test_the_row(self, agents):
        seed_run(agents, 'running')
        before = datetime.now(UTC)
        assert store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n2', 'to_mate', 'Build it') == 1
        [row] = partition(agents, 'MATE#')
        assert timedelta(0) <= _parse_iso(row['at']) - before < timedelta(seconds=5)
        assert row == {'pk': f'RUN#{RUN_ID}', 'sk': 'MATE#builder#000001', 'seq': Decimal('1'), 'at': row['at'],
                       'role': 'builder', 'node_id': 'n2', 'direction': 'to_mate', 'text': 'Build it'}

    def test_text_is_clipped_to_8000_and_none_becomes_empty(self, agents):
        seed_run(agents, 'running')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n2', 'from_mate', 't' * 8000 + 'X')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n2', 'from_mate', NO_TEXT)
        long_row, empty_row = partition(agents, 'MATE#')
        assert long_row['text'] == 't' * 8000
        assert empty_row['text'] == ''

    def test_the_counter_is_separate_from_events_and_shared_across_roles(self, agents):
        seed_run(agents, 'running')
        store.append_event(AGENT_ID, RUN_ID, 'message', 'x')
        assert store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n1', 'to_mate', 'a') == 1
        assert store.append_mate(AGENT_ID, RUN_ID, 'reviewer', 'n1', 'to_mate', 'b') == 2
        assert [row['sk'] for row in partition(agents, 'MATE#')] == ['MATE#builder#000001', 'MATE#reviewer#000002']
        row = run_row(agents)
        assert (row['event_seq'], row['mate_seq']) == (Decimal('1'), Decimal('2'))


class TestGetMate:
    def test_reads_the_exact_row_plain(self, agents):
        seed_run(agents, 'running')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n1', 'to_mate', 'a')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n1', 'from_mate', 'b')
        mate = store.get_mate(RUN_ID, 'builder', 2)
        assert mate is not None
        assert (mate['sk'], mate['seq'], mate['text']) == ('MATE#builder#000002', 2, 'b')
        assert type(mate['seq']) is int

    def test_the_key(self):
        table = _mock_table(get_item=[{}])
        with patch.object(store, '_table', return_value=table):
            assert store.get_mate('ar_7', 'reviewer', 12) is None
        table.get_item.assert_called_once_with(Key={'pk': 'RUN#ar_7', 'sk': 'MATE#reviewer#000012'})

    @pytest.mark.parametrize(('role', 'seq'), [('reviewer', 1), ('builder', 2)])
    def test_missing_is_none(self, agents, role, seq):
        seed_run(agents, 'running')
        store.append_mate(AGENT_ID, RUN_ID, 'builder', 'n1', 'to_mate', 'a')
        assert store.get_mate(RUN_ID, role, seq) is None


class TestReserveModelCall:
    def _agent(self, agents, **overrides: Any) -> dict:
        return store.plain(seed_agent(agents, **overrides))

    def test_counts_up_to_the_budget_and_refuses_the_next(self, agents):
        agent = self._agent(agents)
        seed_run(agents, 'running')
        assert store.reserve_model_call(agent, RUN_ID, 2) == 1
        assert store.reserve_model_call(agent, RUN_ID, 2) == 2
        with pytest.raises(store.BudgetExhausted, match=r'^model-call budget exhausted or run not running$'):
            store.reserve_model_call(agent, RUN_ID, 2)
        assert run_row(agents)['model_calls'] == Decimal('2')

    def test_returns_an_int(self, agents):
        agent = self._agent(agents)
        seed_run(agents, 'running')
        assert type(store.reserve_model_call(agent, RUN_ID, 5)) is int

    def test_a_run_without_a_counter_starts_at_one(self, agents):
        agent = self._agent(agents)
        agents.put_item(Item={**RUN_KEY, 'status': 'running'})
        assert store.reserve_model_call(agent, RUN_ID, 1) == 1
        with pytest.raises(store.BudgetExhausted):
            store.reserve_model_call(agent, RUN_ID, 1)

    @pytest.mark.parametrize('status', ['queued', 'cancelled', 'completed'])
    def test_a_run_that_is_not_running_is_refused_and_not_counted(self, agents, status):
        agent = self._agent(agents)
        seed_run(agents, status)
        with pytest.raises(store.BudgetExhausted, match=r'^model-call budget exhausted or run not running$'):
            store.reserve_model_call(agent, RUN_ID, 10)
        assert run_row(agents)['model_calls'] == Decimal('0')
        assert 'month_calls' not in _agent_row(agents)

    def test_each_reservation_counts_one_call_against_the_month(self, agents):
        agent = self._agent(agents)
        seed_run(agents, 'running')
        store.reserve_model_call(agent, RUN_ID, 10)
        month = datetime.now(UTC).strftime('%Y-%m')
        row = _agent_row(agents)
        assert (row['month_key'], row['month_calls']) == (month, Decimal('1'))
        store.reserve_model_call({**agent, 'month_key': month}, RUN_ID, 10)
        assert _agent_row(agents)['month_calls'] == Decimal('2')

    def test_month_counting_is_called_with_the_table_the_agent_and_one(self, agents):
        agent = self._agent(agents)
        seed_run(agents, 'running')
        with patch.object(store.shared_store, 'count_month_calls') as count:
            store.reserve_model_call(agent, RUN_ID, 10)
        count.assert_called_once()
        assert count.call_args.args[0].name == 'test-agents'
        assert count.call_args.args[1:] == (agent, 1)
        now = count.call_args.kwargs['now']
        assert set(count.call_args.kwargs) == {'now'}
        assert now.tzinfo is UTC
        assert timedelta(0) <= datetime.now(UTC) - now < timedelta(seconds=5)

    def test_other_errors_propagate_uncounted(self):
        with _update_item_raising_boom(), patch.object(store.shared_store, 'count_month_calls') as count:
            store.reserve_model_call({'agent_id': AGENT_ID}, RUN_ID, 1)
        count.assert_not_called()

    def test_a_conditional_failure_from_the_client_is_a_budget_refusal(self):
        table = _mock_table(update_item=_conditional_failure())
        with patch.object(store, '_table', return_value=table), \
                pytest.raises(store.BudgetExhausted, match=r'^model-call budget exhausted or run not running$'):
            store.reserve_model_call({'agent_id': AGENT_ID}, RUN_ID, 1)


class TestMaxCallsFor:
    @pytest.mark.parametrize(('agent', 'expected'), [
        ({}, 150), ({'budget': 'x'}, 150), ({'budget': {}}, 150),
        ({'budget': {'max_model_calls_per_run': 0}}, 150),
        ({'budget': {'max_model_calls_per_run': 1}}, 1),
        ({'budget': {'max_model_calls_per_run': 1000}}, 1000),
        ({'budget': {'max_model_calls_per_run': 1001}}, 150),
        ({'budget': {'max_model_calls_per_run': -5}}, 150),
        ({'budget': {'max_model_calls_per_run': '7'}}, 150),
        ({'budget': {'max_model_calls_per_run': 7.0}}, 150),
        ({'budget': {'max_model_calls_per_run': None}}, 150),
        ({'budget': {'max_model_calls_per_run': 42}}, 42),
    ])
    def test_bounds(self, agent, expected):
        assert store.max_calls_for(agent) == expected
