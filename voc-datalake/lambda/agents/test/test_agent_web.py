"""Agent steps search the public web by default, under ONE per-run cap.

* ``store.reserve_web_queries`` grants searches from the RUN row's
  ``web_queries`` counter and never past ``MAX_WEB_QUERIES_PER_RUN`` (10);
* ``custom_llm`` adds a ``<web_results>`` block planned from its own question
  and the feedback statistics — never from the company context or memories;
* the per-step switch (``params.use_web_search: false``) reserves nothing.
"""
from __future__ import annotations

import re
from decimal import Decimal
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from agents import store
from agents.graph import Node
from agents.nodes import custom_llm, web
from agents.nodes.base import NodeContext
from agents.test.conftest import AGENT_ID, RUN_ID, run_row, seed_run
from shared.agentic_search import AgenticSearchOutcome

AGENT = {'agent_id': AGENT_ID}
SECRET = 'Codename FALCON ships in May'


def test_the_per_run_cap_is_ten_and_the_editor_says_so():
    editor = Path(__file__).resolve().parents[3] / 'frontend/src/components/WorkflowEditor/ParamsFields.tsx'
    shown = re.search(r'const MAX_WEB_QUERIES_PER_RUN = (\d+)', editor.read_text())
    assert (store.MAX_WEB_QUERIES_PER_RUN, shown and int(shown.group(1))) == (10, 10)


class TestReserveWebQueries:
    def test_grants_until_the_cap_then_nothing(self, tables):
        agents, _ = tables
        seed_run(agents, 'running')
        grants = [store.reserve_web_queries(AGENT, RUN_ID, 8) for _ in range(3)]
        assert (grants, run_row(agents)['web_queries']) == ([8, 2, 0], Decimal('10'))

    @pytest.mark.parametrize('status', ['queued', 'completed', 'cancelled'])
    def test_a_run_that_is_not_running_gets_nothing(self, tables, status):
        agents, _ = tables
        seed_run(agents, status)
        assert (store.reserve_web_queries(AGENT, RUN_ID, 3), 'web_queries' in run_row(agents)) == (0, False)

    def test_a_concurrent_grant_loses_rather_than_overshoots(self, tables):
        agents, _ = tables
        seed_run(agents, 'running')
        stale = {**(store.get_run(AGENT_ID, RUN_ID) or {}), 'web_queries': 0}
        store.reserve_web_queries(AGENT, RUN_ID, 9)
        with patch.object(store, 'get_run', return_value=stale):
            assert store.reserve_web_queries(AGENT, RUN_ID, 9) == 0
        assert run_row(agents)['web_queries'] == Decimal('9')


def _ctx(params: dict | None = None) -> tuple[NodeContext, Mock]:
    """A custom step's context and the Mock standing in for its model call."""
    node = Node(id='n_custom', type='custom_llm', title='Competitors', instructions='How do rivals price refunds?',
                role='worker', params=params or {})
    aggregate = {'title': 'Refunds are slow', 'top_problems': [{'title': 'Late refund', 'category': 'billing',
                                                                'evidence_count': 4}]}
    ctx = NodeContext(agent=AGENT, run={'run_id': RUN_ID, 'context': {'aggregate': aggregate}}, node=node,
                      envelope='Do the task', claims={'sub': 'agent:ag_1'})
    ask = Mock(return_value='Answer')
    ctx.ask = ask
    return ctx, ask


@pytest.fixture
def searching():
    outcome = AgenticSearchOutcome(context='Rival A refunds in 24 h (https://example.com)', queries=['refund sla'],
                                   result_count=1)
    with patch.object(web, 'is_web_search_configured', return_value=True), \
            patch.object(web.store, 'reserve_web_queries', return_value=3) as reserve, \
            patch.object(web, 'run_agentic_web_search', return_value=outcome) as search, \
            patch.object(custom_llm.context_blocks, 'company_context', return_value=f'<company_context>{SECRET}'), \
            patch.object(custom_llm.context_blocks, 'memories', return_value=f'<memory>{SECRET}</memory>'):
        yield reserve, search


class TestCustomStep:
    @pytest.mark.usefixtures('searching')
    def test_web_results_reach_the_prompt_with_the_citation_rule(self):
        ctx, ask = _ctx()
        custom_llm.start(ctx)
        prompt, kwargs = ask.call_args.args[0], ask.call_args.kwargs
        assert ('<web_results>' in prompt, kwargs['system_prompt']) == (True, custom_llm.SYSTEM + custom_llm.WEB_GUIDANCE)

    def test_queries_are_planned_from_the_question_and_feedback_stats_only(self, searching):
        reserve, search = searching
        custom_llm.start(_ctx()[0])
        question, hint = search.call_args.args[0], search.call_args.kwargs['context_hint']
        assert (question, SECRET in hint, search.call_args.kwargs['max_queries']) == (
            'How do rivals price refunds?', False, 3)
        reserve.assert_called_once_with(AGENT, RUN_ID, web.STEP_WEB_QUERIES)

    def test_the_step_switch_reserves_and_searches_nothing(self, searching):
        reserve, search = searching
        ctx, ask = _ctx({'use_web_search': False})
        custom_llm.start(ctx)
        assert (reserve.call_count, search.call_count, ask.call_args.kwargs['system_prompt']) == (
            0, 0, custom_llm.SYSTEM)

    def test_a_failed_search_costs_the_block_not_the_step(self, searching):
        _, search = searching
        search.side_effect = RuntimeError('gateway down')
        ctx, ask = _ctx()
        custom_llm.start(ctx)
        assert '<web_results>' not in ask.call_args.args[0]
