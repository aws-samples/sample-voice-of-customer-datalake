"""Mutation hardening for `agents/llm.py`.

The earlier unit tests (``test_runtime_units.py``) checked the allowlist and
the unknown-role refusal, but every caller patched ``llm.ask`` away, so nothing
pinned what actually reaches ``converse``: the role's surface, the defaults
(``max_tokens=2000``, ``step_name='agent'``), ``temperature=None`` and
``max_continuations=0``. Nor did anything pin that ``ask`` reserves exactly one
call against ``store.max_calls_for(agent)`` BEFORE Bedrock is touched, that an
unknown role is refused (by its exact message) before the budget is spent, or
the exact slice ``parse_json_object`` decodes.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from agents import llm, store
from shared.model_config import ALLOWED_MODEL_IDS

AGENT = {'agent_id': 'ag_1', 'budget': {'max_model_calls_per_run': 7}}
ALLOWED = sorted(ALLOWED_MODEL_IDS)[0]
UNKNOWN_ROLE = r'^unknown role admin\Z'


def _sent(converse: MagicMock, prompt: str, surface: str, **options: Any) -> None:
    """``converse`` got exactly one call: the defaults, overridden by ``options``."""
    expected = {'system_prompt': '', 'max_tokens': 2000, 'model_id': None, 'step_name': 'agent', **options}
    converse.assert_called_once_with(
        prompt=prompt, temperature=None, surface=surface, max_continuations=0, **expected)


@pytest.fixture
def converse() -> Iterator[MagicMock]:
    with patch.object(llm, 'converse', return_value='answer') as mock:
        yield mock


@pytest.fixture
def reserve_call() -> Iterator[MagicMock]:
    with patch.object(store, 'reserve_model_call', return_value=1) as mock:
        yield mock


class TestInvokeSendsTheRoleSurfaceAndFixedOptions:
    @pytest.mark.parametrize(('role', 'surface'), [
        ('orchestrator', 'agent_orchestrator'),
        ('worker', 'agent_worker'),
        ('reviewer', 'agent_reviewer'),
        ('persona', 'agent_persona'),
    ])
    def test_defaults(self, converse: MagicMock, role: str, surface: str):
        assert llm.invoke(AGENT, role, 'Hello') == 'answer'
        _sent(converse, 'Hello', surface)

    def test_explicit_options_and_an_allowlisted_override(self, converse: MagicMock):
        agent = {**AGENT, 'models': {'worker': ALLOWED}}
        llm.invoke(agent, 'worker', 'P', system_prompt='S', max_tokens=123, step_name='plan')
        _sent(converse, 'P', 'agent_worker', system_prompt='S', max_tokens=123, model_id=ALLOWED, step_name='plan')

    def test_an_unknown_role_is_refused_by_name(self, converse: MagicMock):
        with pytest.raises(ValueError, match=UNKNOWN_ROLE):
            llm.invoke(AGENT, 'admin', 'x')
        converse.assert_not_called()

    @pytest.mark.parametrize('agent', [
        {'models': {'worker': 5}}, {'models': {'worker': 'evil-model'}},
        {'models': {'reviewer': ALLOWED}}, {'models': {}}, {},
    ])
    def test_an_override_that_is_not_an_allowlisted_string_for_the_role_is_ignored(self, agent: dict):
        assert llm.model_override(agent, 'worker') is None


class TestAskReservesBeforeCalling:
    def test_reserves_one_call_against_the_agents_budget(self, converse: MagicMock, reserve_call: MagicMock):
        assert llm.ask(AGENT, 'ar_1', 'persona', 'Q') == 'answer'
        reserve_call.assert_called_once_with(AGENT, 'ar_1', 7)
        _sent(converse, 'Q', 'agent_persona')

    def test_passes_its_options_through(self, converse: MagicMock, reserve_call: MagicMock):
        llm.ask(AGENT, 'ar_1', 'reviewer', 'Q', system_prompt='S', max_tokens=9, step_name='review')
        reserve_call.assert_called_once_with(AGENT, 'ar_1', 7)
        _sent(converse, 'Q', 'agent_reviewer', system_prompt='S', max_tokens=9, step_name='review')

    def test_an_exhausted_budget_never_reaches_bedrock(self, converse: MagicMock, reserve_call: MagicMock):
        reserve_call.side_effect = store.BudgetExhausted()
        with pytest.raises(store.BudgetExhausted):
            llm.ask(AGENT, 'ar_1', 'worker', 'Q')
        converse.assert_not_called()

    def test_an_unknown_role_spends_no_budget(self, converse: MagicMock, reserve_call: MagicMock):
        with pytest.raises(ValueError, match=UNKNOWN_ROLE):
            llm.ask(AGENT, 'ar_1', 'admin', 'Q')
        reserve_call.assert_not_called()
        converse.assert_not_called()

    def test_reserve_uses_max_calls_for(self, reserve_call: MagicMock):
        llm.reserve({'agent_id': 'ag_2'}, 'ar_9')
        reserve_call.assert_called_once_with(
            {'agent_id': 'ag_2'}, 'ar_9', store.DEFAULT_MAX_MODEL_CALLS_PER_RUN)


class TestParseJsonObject:
    @pytest.mark.parametrize(('text', 'expected'), [
        ('{"a": 1}', {'a': 1}),
        ('  {"a": {"b": 2}}  ', {'a': {'b': 2}}),
        ('```json\n{"k": "v"}\n```', {'k': 'v'}),
        ('{}', {}),
        ('Sure: {"a": 1}.', {'a': 1}),
    ])
    def test_the_whole_outer_object_is_decoded(self, text: str, expected: dict):
        assert llm.parse_json_object(text) == expected

    @pytest.mark.parametrize('text', ['', 'no json', '}{', '} x {', '[1]', '{"a": 1', 'a}'])
    def test_anything_else_is_none(self, text: str):
        assert llm.parse_json_object(text) is None

    def test_none_text_is_none(self):
        text: Any = None  # a model client can hand back None
        assert llm.parse_json_object(text) is None
