"""Mutation hardening for `agents/nodes/select_personas.py`.

No earlier test imported the node. `test_conductor_run.py` drives it only through
the conductor with the seeded agent's ``personas.fixed == []``, which reaches the
``0 fixed persona(s) on the panel`` result without ever reading a ref, calling
``GET /projects/{id}`` or dropping anything. A mutation run therefore found the
node's whole contribution unobserved:

* which refs count — only dict entries whose ``project_id`` and ``persona_id``
  are both strings, reduced to exactly those two keys, in the agent's order,
  and never more than the first ``MAX_FIXED == 6``;
* the one ``GET /projects/{id}`` per DISTINCT project, made as the agent
  (``ctx.claims``), whose ``personas`` list decides which refs stay — a
  ``RouteError`` (project unreadable) or a project without personas drops them
  silently, anything else propagates;
* the summary — ``N fixed persona(s) on the panel`` and, only when something was
  dropped, ``; M not readable and dropped``;
* the result — exactly ``node_id``, ``status: 'done'``, ``summary`` and
  ``updates.fixed_personas`` (the kept refs, in order, ``[]`` included).

Every expectation here is the literal string, number or dict the module emits.
"""
from __future__ import annotations

from unittest.mock import MagicMock, call, patch

import pytest

from agents import principal
from agents.graph import Node
from agents.nodes import select_personas
from agents.nodes.base import NodeContext

CLAIMS = {'sub': 'owner-sub', 'email': 'owner@example.com'}
P1, P2 = 'proj_a', 'proj_b'


def _ref(project_id: str, persona_id: str) -> dict[str, str]:
    return {'project_id': project_id, 'persona_id': persona_id}


def _agent(personas: object) -> dict:
    return {'agent_id': 'ag_1', 'personas': personas}


def _ctx(agent: dict) -> NodeContext:
    node = Node(id='personas_fixed', type='select_personas', title='Fixed personas', instructions='',
                role='orchestrator', params={})
    return NodeContext(agent=agent, run={'run_id': 'ar_1', 'context': {}}, node=node, envelope='',
                       claims=CLAIMS)


def _project(*persona_ids: object) -> dict:
    return {'project': {'project_id': 'x'}, 'personas': [{'persona_id': pid} for pid in persona_ids]}


def _run(agent: dict, projects: dict[str, object]) -> tuple[dict, MagicMock]:
    """Run `start` against a `get_project` that answers per project id (an exception instance is raised)."""
    def get_project(project_id: str, _claims: dict) -> dict:
        answer = projects[project_id]
        if isinstance(answer, Exception):
            raise answer
        assert isinstance(answer, dict)
        return answer

    with patch('agents.principal.get_project', side_effect=get_project) as mocked:
        return select_personas.start(_ctx(agent)), mocked


class TestWhichRefsCount:
    def test_max_fixed_is_six(self):
        assert select_personas.MAX_FIXED == 6

    @pytest.mark.parametrize('personas', [None, 'fixed', [], {}, {'fixed': None}, {'fixed': []}, {'fixed': 'x'},
                                          {'fixed': {'project_id': P1, 'persona_id': 'per_1'}}])
    def test_no_usable_fixed_list_means_no_refs(self, personas):
        assert select_personas._fixed_refs(_agent(personas)) == []

    @pytest.mark.parametrize('entry', [
        'per_1', ['proj_a', 'per_1'], None,
        {'project_id': P1}, {'persona_id': 'per_1'},
        {'project_id': 7, 'persona_id': 'per_1'}, {'project_id': P1, 'persona_id': None},
        {'project_id': [P1], 'persona_id': 'per_1'}, {'project_id': P1, 'persona_id': ['per_1']},
    ])
    def test_an_entry_without_two_string_ids_is_skipped(self, entry):
        agent = _agent({'fixed': [_ref(P1, 'per_0'), entry, _ref(P2, 'per_2')]})
        assert select_personas._fixed_refs(agent) == [_ref(P1, 'per_0'), _ref(P2, 'per_2')]

    def test_only_the_two_ids_survive_in_the_agents_order(self):
        agent = _agent({'fixed': [
            {'project_id': P2, 'persona_id': 'per_2', 'name': 'Ann', 'pinned': True},
            {'persona_id': 'per_1', 'project_id': P1},
        ]})
        assert select_personas._fixed_refs(agent) == [_ref(P2, 'per_2'), _ref(P1, 'per_1')]

    @pytest.mark.parametrize(('given', 'kept'), [(5, 5), (6, 6), (7, 6), (12, 6)])
    def test_at_most_the_first_six_refs_count(self, given, kept):
        refs = [_ref(P1, f'per_{i}') for i in range(given)]
        result = select_personas._fixed_refs(_agent({'fixed': refs}))
        assert result == refs[:kept]
        assert len(result) == kept


class TestOneReadPerDistinctProjectAsTheAgent:
    def test_each_project_is_read_once_with_the_agents_claims(self):
        agent = _agent({'fixed': [_ref(P1, 'per_1'), _ref(P2, 'per_2'), _ref(P1, 'per_3')]})
        _result, get_project = _run(agent, {P1: _project('per_1', 'per_3'), P2: _project('per_2')})
        assert get_project.call_args_list == [call(P1, CLAIMS), call(P2, CLAIMS)]

    def test_no_refs_means_no_read_at_all(self):
        result, get_project = _run(_agent({'fixed': []}), {})
        assert get_project.call_args_list == []
        assert result == {'node_id': 'personas_fixed', 'status': 'done',
                          'summary': '0 fixed persona(s) on the panel', 'updates': {'fixed_personas': []}}

    def test_the_seventh_ref_is_never_looked_up(self):
        refs = [_ref(f'proj_{i}', f'per_{i}') for i in range(7)]
        result, get_project = _run(_agent({'fixed': refs}),
                                   {f'proj_{i}': _project(f'per_{i}') for i in range(7)})
        assert get_project.call_args_list == [call(f'proj_{i}', CLAIMS) for i in range(6)]
        assert result['updates'] == {'fixed_personas': refs[:6]}


class TestWhatStaysOnThePanel:
    def test_only_refs_the_project_lists_stay_in_order(self):
        agent = _agent({'fixed': [_ref(P1, 'per_1'), _ref(P2, 'per_2'), _ref(P1, 'per_missing'), _ref(P1, 'per_3')]})
        result, _ = _run(agent, {P1: _project('per_3', 'per_1'), P2: _project('per_2')})
        assert result == {
            'node_id': 'personas_fixed', 'status': 'done',
            'summary': '3 fixed persona(s) on the panel; 1 not readable and dropped',
            'updates': {'fixed_personas': [_ref(P1, 'per_1'), _ref(P2, 'per_2'), _ref(P1, 'per_3')]},
        }

    def test_nothing_dropped_means_no_dropped_clause(self):
        agent = _agent({'fixed': [_ref(P1, 'per_1'), _ref(P1, 'per_2')]})
        result, _ = _run(agent, {P1: _project('per_1', 'per_2')})
        assert result['summary'] == '2 fixed persona(s) on the panel'
        assert result['updates'] == {'fixed_personas': [_ref(P1, 'per_1'), _ref(P1, 'per_2')]}

    @pytest.mark.parametrize('answer', [
        principal.RouteError(404, 'Project not found'),
        principal.RouteError(502, 'project response was malformed'),
        {'project': {}},
        {'project': {}, 'personas': None},
        {'project': {}, 'personas': []},
        {'project': {}, 'personas': ['per_1', None, {'persona_id': 7}, {'name': 'per_1'}, {'persona_id': ['per_1']}]},
    ])
    def test_an_unreadable_or_personaless_project_drops_its_refs(self, answer):
        agent = _agent({'fixed': [_ref(P1, 'per_1'), _ref(P2, 'per_2')]})
        result, get_project = _run(agent, {P1: answer, P2: _project('per_2')})
        assert get_project.call_args_list == [call(P1, CLAIMS), call(P2, CLAIMS)]
        assert result == {
            'node_id': 'personas_fixed', 'status': 'done',
            'summary': '1 fixed persona(s) on the panel; 1 not readable and dropped',
            'updates': {'fixed_personas': [_ref(P2, 'per_2')]},
        }

    def test_every_ref_dropped_still_answers_done_with_an_empty_panel(self):
        agent = _agent({'fixed': [_ref(P1, 'per_1'), _ref(P1, 'per_2'), _ref(P2, 'per_3')]})
        result, _ = _run(agent, {P1: principal.RouteError(404, 'Project not found'), P2: _project('other')})
        assert result == {'node_id': 'personas_fixed', 'status': 'done',
                          'summary': '0 fixed persona(s) on the panel; 3 not readable and dropped',
                          'updates': {'fixed_personas': []}}

    def test_a_non_route_error_propagates(self):
        agent = _agent({'fixed': [_ref(P1, 'per_1')]})
        with pytest.raises(RuntimeError, match='boom'):
            _run(agent, {P1: RuntimeError('boom')})
