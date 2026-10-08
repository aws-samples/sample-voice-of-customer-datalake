"""Mutation hardening for `agents/nodes/handler.py`.

`test_conductor_run.py` drives whole runs through the node Lambda, so a start
that dispatches to the wrong module or a poll that never finishes is caught
there. A mutation run found what the end-to-end drive cannot see:

* the WORDING of every refusal and of the pending summary. The conductor records
  `str(exc)` on the run and the summary is what the activity journal shows, so
  ``persona_review is not executed by the node Lambda``, ``poll without a pending
  job``, ``the write_prd job failed`` and ``Title: <step>`` are pinned as literals.
* each terminal job status on its own: ``failed``, ``error`` and ``cancelled`` all
  refuse, ``completed`` alone hands the job to the module's ``finish``, and any
  other status (or none at all) stays pending with the step name, then the
  status, then ``running`` as the summary — in that order.
* the poll guard on each half of the pending claim (a missing or non-string
  ``project_id`` or ``job_id``) and ``get_job`` called with exactly the claim and
  the agent's claims.
* the routing in ``execute``: only ``action: 'poll'`` polls, and it polls the
  event's ``pending``; anything else starts the node's module.
* the finished log line of the Lambda entry point.
"""
from __future__ import annotations

from collections.abc import Iterator
from unittest.mock import MagicMock, patch

import pytest

from agents.graph import Node
from agents.nodes import handler
from agents.nodes.base import NodeContext, NodeFailure

CLAIMS = {'sub': 'agent:ag_1', 'cognito:groups': 'users'}
WAITING = {'project_id': 'proj_1', 'job_id': 'job_1'}


def _ctx(node_type: str = 'write_prd', title: str = 'Write the PRD') -> NodeContext:
    node = Node(id='n_prd', type=node_type, title=title, instructions='', role='worker', params={})
    return NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'run_1', 'context': {}},
                       node=node, envelope='', claims=dict(CLAIMS))


@pytest.fixture
def get_job() -> Iterator[MagicMock]:
    with patch('agents.principal.get_job') as mock:
        yield mock


class TestExecutableTypes:
    def test_the_exact_set_of_node_types_this_lambda_runs(self):
        assert sorted(handler.EXECUTABLE_TYPES) == [
            'aggregate_reviews', 'build_prototype', 'collect_prototype_feedback', 'custom_llm',
            'deep_research', 'duplicate_document', 'final_review', 'generate_personas', 'handoff',
            'revise_document', 'revise_prototype', 'select_or_create_project', 'select_personas',
            'write_prd', 'write_prfaq',
        ]

    def test_the_job_status_constants(self):
        assert handler.JOB_DONE == 'completed'
        assert sorted(handler.JOB_FAILED) == ['cancelled', 'error', 'failed']

    @pytest.mark.parametrize('node_type', sorted(handler.EXECUTABLE_TYPES))
    def test_every_executable_type_resolves_to_its_own_module(self, node_type):
        module = handler._module(node_type)
        assert module.__name__ == f'agents.nodes.{node_type}'
        assert callable(module.start)

    @pytest.mark.parametrize('node_type', ['persona_review', 'start', 'end', 'write_prdx', ''])
    def test_other_types_are_refused_by_name(self, node_type):
        with pytest.raises(NodeFailure) as exc:
            handler._module(node_type)
        assert str(exc.value) == f'{node_type} is not executed by the node Lambda'


class TestPollGuardsThePendingClaim:
    @pytest.mark.parametrize('waiting', [
        None, 'proj_1/job_1', [], {},
        {'project_id': 'proj_1'},
        {'job_id': 'job_1'},
        {'project_id': 1, 'job_id': 'job_1'},
        {'project_id': 'proj_1', 'job_id': None},
        {'project_id': None, 'job_id': None},
    ])
    def test_a_claim_missing_either_id_is_refused_before_any_call(self, get_job, waiting):
        with pytest.raises(NodeFailure) as exc:
            handler._poll(_ctx(), waiting)
        assert str(exc.value) == 'poll without a pending job'
        assert get_job.call_args_list == []

    def test_the_job_is_fetched_with_the_claim_and_the_agent_claims(self, get_job):
        get_job.return_value = {'status': 'running'}

        handler._poll(_ctx(), WAITING)

        get_job.assert_called_once_with('proj_1', 'job_1', CLAIMS)


class TestPollMapsEveryJobStatus:
    def test_completed_hands_the_job_to_the_module_finish(self, get_job):
        job = {'status': 'completed', 'result': {'document_id': 'doc_9'}}
        get_job.return_value = job
        ctx = _ctx('write_prd')
        with patch('agents.nodes.write_prd.finish', return_value={'node_id': 'n_prd', 'status': 'done'}) as finish:
            assert handler._poll(ctx, WAITING) == {'node_id': 'n_prd', 'status': 'done'}
        finish.assert_called_once_with(ctx, job)

    def test_completed_uses_the_node_type_to_pick_the_module(self, get_job):
        get_job.return_value = {'status': 'completed'}
        with (patch('agents.nodes.generate_personas.finish', return_value={'picked': 'personas'}) as personas,
              patch('agents.nodes.write_prd.finish') as prd):
            assert handler._poll(_ctx('generate_personas'), WAITING) == {'picked': 'personas'}
        assert personas.call_count == 1
        assert prd.call_args_list == []

    @pytest.mark.parametrize('status', ['failed', 'error', 'cancelled'])
    @pytest.mark.parametrize('node_type', ['write_prd', 'deep_research'])
    def test_each_terminal_status_fails_naming_the_node_type(self, get_job, status, node_type):
        get_job.return_value = {'status': status, 'current_step': 'Still shown nowhere'}
        with patch(f'agents.nodes.{node_type}.finish') as finish, pytest.raises(NodeFailure) as exc:
            handler._poll(_ctx(node_type), WAITING)
        assert str(exc.value) == f'the {node_type} job failed'
        assert finish.call_args_list == []

    @pytest.mark.parametrize(('job', 'summary'), [
        ({'status': 'running', 'current_step': 'Drafting sections'}, 'Write the PRD: Drafting sections'),
        ({'status': 'in_progress'}, 'Write the PRD: in_progress'),
        ({'status': 'in_progress', 'current_step': ''}, 'Write the PRD: in_progress'),
        ({'status': 'queued', 'current_step': None}, 'Write the PRD: queued'),
        ({}, 'Write the PRD: running'),
        ({'status': '', 'current_step': ''}, 'Write the PRD: running'),
        ({'status': None}, 'Write the PRD: running'),
        ({'status': 'completedx'}, 'Write the PRD: completedx'),
        ({'status': 'COMPLETED'}, 'Write the PRD: COMPLETED'),
    ])
    def test_any_other_status_stays_pending_with_the_step_then_status_then_running(self, get_job, job, summary):
        get_job.return_value = job
        with patch('agents.nodes.write_prd.finish') as finish:
            result = handler._poll(_ctx(), WAITING)
        assert result == {
            'node_id': 'n_prd', 'status': 'pending', 'summary': summary,
            'pending': {'project_id': 'proj_1', 'job_id': 'job_1'},
        }
        assert finish.call_args_list == []


class TestExecuteRoutesOnTheAction:
    """`runtime.run_step` is replaced by a fake that runs the step on a fixed context."""

    @staticmethod
    def _run_step_with(ctx: NodeContext) -> MagicMock:
        return MagicMock(side_effect=lambda _event, step: step(ctx))

    def test_poll_polls_the_event_pending(self, get_job):
        get_job.return_value = {'status': 'running', 'current_step': 'Step 2'}
        ctx = _ctx()
        event = {'action': 'poll', 'agent_id': 'ag_1', 'run_id': 'run_1', 'node_id': 'n_prd', 'pending': WAITING}
        run_step = self._run_step_with(ctx)
        with patch('agents.runtime.run_step', run_step), patch('agents.nodes.write_prd.start') as start:
            result = handler.execute(event)

        assert result['summary'] == 'Write the PRD: Step 2'
        assert result['pending'] == {'project_id': 'proj_1', 'job_id': 'job_1'}
        get_job.assert_called_once_with('proj_1', 'job_1', CLAIMS)
        assert start.call_args_list == []
        assert run_step.call_args[0][0] is event

    def test_poll_without_pending_in_the_event_is_refused_inside_the_step(self, get_job):
        ctx = _ctx()
        with patch('agents.runtime.run_step', self._run_step_with(ctx)), pytest.raises(NodeFailure) as exc:
            handler.execute({'action': 'poll', 'node_id': 'n_prd'})
        assert str(exc.value) == 'poll without a pending job'
        assert get_job.call_args_list == []

    @pytest.mark.parametrize('action', ['start', None, 'pollx', 'POLL', ''])
    def test_anything_but_poll_starts_the_module_of_the_node_type(self, get_job, action):
        ctx = _ctx('deep_research')
        event = {'action': action, 'node_id': 'n_prd', 'pending': WAITING}
        if action is None:
            del event['action']
        run_step = self._run_step_with(ctx)
        with (patch('agents.runtime.run_step', run_step),
              patch('agents.nodes.deep_research.start', return_value={'started': 'research'}) as start,
              patch('agents.nodes.write_prd.start') as other):
            assert handler.execute(event) == {'started': 'research'}

        start.assert_called_once_with(ctx)
        assert other.call_args_list == []
        assert get_job.call_args_list == []
        assert run_step.call_args[0][0] is event

    def test_start_of_a_type_this_lambda_does_not_run_is_refused(self):
        with (patch('agents.runtime.run_step', self._run_step_with(_ctx('persona_review'))),
              pytest.raises(NodeFailure) as exc):
            handler.execute({'action': 'start', 'node_id': 'n_prd'})
        assert str(exc.value) == 'persona_review is not executed by the node Lambda'


class TestLambdaEntryPoint:
    def test_returns_the_step_result_and_logs_the_finished_line(self):
        context = MagicMock()
        context.function_name = 'voc-agent-nodes'
        context.memory_limit_in_mb = 512
        context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-agent-nodes'
        context.aws_request_id = 'req-1'
        result = {'node_id': 'n_prd', 'status': 'pending', 'summary': 'x', 'pending': WAITING}
        with (patch('agents.runtime.run_step', return_value=result) as run_step,
              patch('agents.runtime.logger') as logger):
            assert handler.lambda_handler({'action': 'poll', 'node_id': 'n_prd', 'pending': WAITING}, context) == result

        assert run_step.call_args[0][0] == {'action': 'poll', 'node_id': 'n_prd', 'pending': WAITING}
        logger.info.assert_called_once_with('Node step finished', extra={'node_status': 'pending'})
