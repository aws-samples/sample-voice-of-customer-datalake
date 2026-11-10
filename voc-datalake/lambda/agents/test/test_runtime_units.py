"""Units: principal claims, persona verdicts, planning fallbacks, node guards."""
from __future__ import annotations

from typing import Any, ClassVar
from unittest.mock import patch

import pytest

from agents import llm, principal
from agents.conductor import planning
from agents.graph import Node
from agents.nodes.base import NodeContext
from agents.persona_panel import handler as panel
from shared import project_access


class TestAgentClaims:
    def test_round_trip_through_project_access(self):
        claims = principal.agent_claims({'agent_id': 'ag_1', 'owner_sub': 'o'},
                                        owner_sub='po', editor_subs=('e1', 'mcp:x', 'e,2'))
        caller = project_access.caller_from_claims(claims, [])

        assert claims['cognito:groups'] == ''
        assert (caller.subject, caller.agent_id, caller.agent_owner_sub) == ('o', 'ag_1', 'po')
        assert caller.agent_editor_subs == ('e1',)
        assert caller.is_admin is False


class TestVerdicts:
    PERSONA: ClassVar[dict[str, str]] = {'persona_id': 'p1', 'name': 'Ana'}

    def test_a_fenced_verdict_is_parsed_and_bounded(self):
        verdict = panel.parse_verdict(
            '```json\n{"score": 3, "objections": ["a", 7, "' + 'x' * 900 + '"], "blocking": "yes"}\n```',
            self.PERSONA)
        assert verdict is not None
        assert verdict['score'] == 3.0
        assert verdict['blocking'] is False
        assert verdict['objections'][0] == 'a'
        assert len(verdict['objections'][1]) == 400



AGENT = {'agent_id': 'ag_1', 'owner_sub': 'o', 'budget': {'max_model_calls_per_run': 5}}


class TestPlanning:
    CANDIDATES: ClassVar[list[dict[str, Any]]] = [
        {'project_id': 'p1', 'name': 'Checkout', 'purpose': 'checkout friction', 'access': {'can_edit': True},
         'created_by_agent': 'ag_1', 'visibility': 'private'},
        {'project_id': 'p2', 'name': 'Secret', 'access': {'can_edit': False}},
        # Someone else's PUBLIC project: editable by everyone, but not this agent's business.
        {'project_id': 'p3', 'name': 'Team wiki', 'access': {'can_edit': True}, 'visibility': 'public',
         'owner': {'sub': 'someone-else'}},
    ]

    def _decide(self, answer):
        with patch.object(llm, 'ask', return_value=answer):
            return planning.decide_project(AGENT, 'r', 'Slow checkout\n...', self.CANDIDATES, 'do it')

    @pytest.mark.parametrize('answer', [
        '{"action":"reuse","project_id":"p2"}',     # not editable
        '{"action":"reuse","project_id":"p3"}',     # someone else's public project
        '{"action":"reuse","project_id":"p9"}',     # hallucinated
    ])
    def test_reuse_of_anything_else_becomes_create(self, answer):
        decision = self._decide(answer)
        assert decision['action'] == 'create'
        assert decision['project_id'] is None


def _ctx(**context):
    node = Node(id='n', type='revise_document', title='Revise', instructions='', role='worker', params={})
    return NodeContext(agent={'agent_id': 'ag_1'}, run={'run_id': 'r', 'context': context}, node=node, envelope='')


class TestNodeGuards:
    def test_generation_can_be_switched_off(self):
        from agents.nodes import generate_personas
        ctx = _ctx(project_id='p1')
        ctx.agent['personas'] = {'allow_generate': False}
        assert generate_personas.start(ctx)['status'] == 'done'


class TestStepHandlerInvocationCost:
    """Every agent step (nodes, persona panel) logs its CPU use: the sizing policy's
    CPU rule had no figure for these functions (docs/lambda-sizing.md)."""

    def test_a_step_logs_one_invocation_cost_line(self):
        from unittest.mock import MagicMock

        from agents import runtime

        context = MagicMock()
        context.function_name = 'voc-agent-nodes'
        context.memory_limit_in_mb = '1024'
        context.invoked_function_arn = 'arn:aws:lambda:us-east-1:123456789012:function:voc-agent-nodes'
        context.aws_request_id = 'req-1'
        handler = runtime.step_lambda_handler(lambda _event: {'status': 'done'}, 'Step finished')

        with patch('shared.invocation_cost.logger') as cost_logger:
            assert handler({'node_id': 'n1'}, context) == {'status': 'done'}

        [call] = [c for c in cost_logger.info.call_args_list if c.args == ('invocation_cost',)]
        assert call.kwargs['extra']['function_memory_size'] == 1024
        assert 'cpu_pct_of_allocation' in call.kwargs['extra']
