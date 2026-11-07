"""The methodology block in agent run and plan journals (agents/run_methodology.py, tenet 2).

A node that starts a methodology step carries the route's block on its pending result,
the finished job's block rides on the done result, and the conductor journals both.
An approved plan's write step stores the route's block on its step row and its
``step_finished`` journal row, and the plan view shows it.
"""
from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest
from boto3.dynamodb.conditions import Key

from agents import run_methodology
from agents.conductor import plan_execution
from agents.graph import Node
from agents.nodes import base
from agents.test.plan_fixtures import PlanEnv, conduct, plan_env, plan_of, write_step
from shared import agents_store
from shared import plans_store as ps

T0 = datetime(2026, 4, 1, 10, 0, tzinfo=UTC)
BLOCK = {'step': 'prd', 'skipped': [{'step': 'prfaq', 'reason': 'missing'}],
         'warnings': [{'code': 'missing_upstream', 'message': 'This PRD is made without a PR/FAQ.', 'step': 'prfaq'}],
         'evidence': None}
FINAL = {**BLOCK, 'evidence': 14}


def _ctx() -> base.NodeContext:
    node = Node(id='n1', type='write_prd', title='Write the PRD', role='writer', params={}, instructions='')
    return base.NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'ar_1', 'context': {'project_id': 'p1'}},
                            node=node, envelope='')


class TestTheNodeCarriesTheBlock:
    def test_a_start_answer_s_block_rides_on_the_pending_result(self):
        result = base.started_job(_ctx(), {'job_id': 'j1', 'methodology': {**BLOCK, 'extra': 1}}, 'p1', 'Started')
        assert result['status'] == 'pending'
        assert result['methodology'] == BLOCK

    @pytest.mark.parametrize('payload', [{'job_id': 'j1'}, {'job_id': 'j1', 'methodology': 'prd'}])
    def test_no_block_means_no_field(self, payload):
        assert 'methodology' not in base.started_job(_ctx(), payload, 'p1', 'Started')

    def test_the_finished_job_s_block_rides_on_the_done_result(self):
        job = {'result': {'document_id': 'd1', 'methodology': FINAL}}
        assert base.job_methodology(job) == FINAL
        assert base.done(_ctx(), 'PRD written', methodology=base.job_methodology(job))['methodology'] == FINAL

    def test_a_job_without_a_block_adds_nothing(self):
        assert 'methodology' not in base.done(_ctx(), 'PRD written', methodology=base.job_methodology({'result': {}}))


class TestTheConductorJournalsIt:
    def test_the_start_block_is_one_message_event(self):
        node = _ctx().node
        with patch.object(run_methodology.store, 'append_event') as append:
            run_methodology.record_start('ag_1', 'ar_1', node, {'status': 'pending', 'methodology': BLOCK})
        append.assert_called_once_with(
            'ag_1', 'ar_1', 'message', 'Methodology (PRD): skipped a PR/FAQ; 1 warning(s).',
            node_id='n1', role='writer', methodology_block=BLOCK)

    def test_a_poll_without_a_block_journals_nothing(self):
        with patch.object(run_methodology.store, 'append_event') as append:
            run_methodology.record_start('ag_1', 'ar_1', _ctx().node, {'status': 'pending'})
        append.assert_not_called()

    def test_the_finished_event_carries_the_final_block_only_when_there_is_one(self):
        assert run_methodology.finished_kwargs({'methodology': FINAL}) == {'methodology_block': FINAL}
        assert run_methodology.finished_kwargs({}) == {}

    def test_the_store_writes_the_bounded_block_on_the_event(self):
        table = MagicMock()
        table.update_item.return_value = {'Attributes': {'event_seq': 3}}
        with patch.object(run_methodology.store, '_table', return_value=table), \
                patch.object(run_methodology.store, '_next_seq', return_value=3):
            run_methodology.store.append_event('ag_1', 'ar_1', 'node_finished', 'PRD written',
                                               methodology_block={**FINAL, 'unexpected': 1})
        assert table.put_item.call_args.kwargs['Item']['methodology'] == FINAL

    def test_the_events_route_answers_the_block(self):
        table = MagicMock()
        table.query.return_value = {'Items': [{'seq': 1, 'kind': 'message', 'summary': 's', 'methodology': BLOCK,
                                               'pk': 'RUN#ar_1'}]}
        assert agents_store.list_events(table, 'ar_1', after=0, limit=10) == [
            {'seq': 1, 'kind': 'message', 'summary': 's', 'methodology': BLOCK}]


@pytest.fixture
def env() -> Iterator[PlanEnv]:
    with plan_env() as environment, patch.object(agents_store, 'utc_now', return_value=T0):
        yield environment


def _claimed(env: PlanEnv) -> str:
    step = write_step('s1', 'generate_document', {'project_id': 'p1', 'doc_type': 'prd', 'title': 'PRD'},
                      pack='project')
    plan_id = env.create(plan_of(step), now=T0)
    conduct({'action': 'plan_decide', 'plan_id': plan_id})
    assert plan_execution.prepare(plan_id, 's1')['run'] is True
    return plan_id


def _journal(env: PlanEnv, plan_id: str) -> list[dict]:
    page = env.agents.query(KeyConditionExpression=Key('pk').eq(f'PLAN#{plan_id}') & Key('sk').begins_with('EVT#'))
    return [item for item in page['Items'] if item['kind'] == 'step_finished']


class TestAPlanStepRecordsIt:
    def test_the_step_row_the_view_and_the_journal_row_carry_the_block(self, env: PlanEnv):
        plan_id = _claimed(env)
        plan_execution.record(plan_id, 's1', {'status': 'done', 'outputs': {}, 'methodology': BLOCK}, None)
        assert env.steps(plan_id)['s1']['methodology'] == BLOCK
        assert ps.step_view(env.steps(plan_id)['s1'])['methodology'] == BLOCK
        [row] = _journal(env, plan_id)
        assert row['methodology'] == BLOCK

    def test_a_step_without_a_block_stores_none(self, env: PlanEnv):
        plan_id = _claimed(env)
        plan_execution.record(plan_id, 's1', {'status': 'done', 'outputs': {}, 'methodology': 'x'}, None)
        assert 'methodology' not in env.steps(plan_id)['s1']
        assert 'methodology' not in ps.step_view(env.steps(plan_id)['s1'])
        [row] = _journal(env, plan_id)
        assert 'methodology' not in row
