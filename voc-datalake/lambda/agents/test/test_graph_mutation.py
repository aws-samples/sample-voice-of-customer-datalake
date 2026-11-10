"""Mutation hardening for `agents/graph.py`.

`test_graph_and_state_machine.py` walks the default template and refuses a
handful of broken definitions, but a mutation run found 91 things it cannot see:

* the WORDING of every refusal. The conductor fails a run at init with
  `str(exc)` as the run's error, so the message is what an operator reads in
  the run journal. Every message is pinned here as a literal, including the
  loop's 1-based position.
* the ACCEPTED side of every bound: exactly 2 and exactly 60 nodes, rounds of
  exactly 1 and exactly 5, a 64-character id, a 200-character title and an
  8000-character instruction all walk; one more of each is refused or cut.
* each entry of the vocabulary tables (node types, roles, edge labels, loop
  kinds, default roles): the earlier tests touched only the entries the default
  template uses, so a vocabulary word that drifted (``write_prd`` becoming
  ``XXwrite_prdXX``) was invisible.
* that `review_pass` loops gate on every node EXCEPT a persona review (the
  default template declares only `persona_agreement` loops).
"""
from __future__ import annotations

import dataclasses
from typing import Any

import pytest

from agents.graph import (
    FAILING_OUTCOMES,
    MAX_LOOP_ROUNDS,
    MAX_NODES,
    SCHEMA,
    Edge,
    Loop,
    Node,
    WorkflowError,
    WorkflowGraph,
)
from shared import workflow_schema

START = {'id': 's', 'type': 'start'}
END = {'id': 'e', 'type': 'end'}
# Every definition here carries exactly these two; another node type gets a node of its own.
BUILTIN_IDS = {'start': 's', 'end': 'e'}


def _node(node_id: str, node_type: str, **data: Any) -> dict[str, Any]:
    return {'id': node_id, 'type': node_type, 'data': data}


def _definition(*nodes: dict[str, Any], edges: list[Any] | None = None, loops: list[Any] | None = None,
                ) -> dict[str, Any]:
    return {'schema': SCHEMA, 'nodes': [START, *nodes, END], 'edges': edges or [], 'loops': loops or []}


def _edge(source: str, target: str, label: str | None = None) -> dict[str, Any]:
    return {'source': source, 'target': target, 'label': label}


def _loop(node_ids: Any, until: Any = 'review_pass', max_rounds: Any = 2) -> dict[str, Any]:
    return {'node_ids': node_ids, 'until': until, 'max_rounds': max_rounds}


def _filler(count: int) -> list[dict[str, Any]]:
    return [_node(f'n{i}', 'handoff') for i in range(count)]


def _ids(graph: WorkflowGraph, node_id: str, outcome: str | None) -> list[str]:
    return [n.id for n in graph.next_nodes(node_id, outcome)]


class TestEveryRefusalNamesItsCause:
    @pytest.mark.parametrize(('definition', 'message'), [
        (None, 'definition is not voc-workflow/1'),
        ({'schema': 'voc-workflow/2', 'nodes': [START, END]}, 'definition is not voc-workflow/1'),
        ({'schema': SCHEMA}, 'a workflow needs 2-60 nodes'),
        ({'schema': SCHEMA, 'nodes': 'se'}, 'a workflow needs 2-60 nodes'),
        ({'schema': SCHEMA, 'nodes': [START]}, 'a workflow needs 2-60 nodes'),
        (_definition(*_filler(59)), 'a workflow needs 2-60 nodes'),
        ({'schema': SCHEMA, 'nodes': [START, 'end']}, 'every node must be an object'),
        (_definition({'type': 'handoff'}), 'node ? has an unknown type'),
        (_definition({'id': '  ', 'type': 'handoff'}), 'node ? has an unknown type'),
        (_definition({'id': 'sh', 'type': 'shell_exec'}), 'node sh has an unknown type'),
        (_definition({'id': 'sh'}), 'node sh has an unknown type'),
        (_definition(_node('e', 'handoff')), 'duplicate node id e'),
        (_definition(_node('s2', 'start')), 'a workflow needs exactly one start node'),
        ({'schema': SCHEMA, 'nodes': [END, _node('x', 'handoff')]}, 'a workflow needs exactly one start node'),
        (_definition(edges=['s->e']), 'every edge must be an object'),
        (_definition(edges=[_edge('s', 'ghost')]), 'an edge points at a missing node'),
        (_definition(edges=[_edge('ghost', 'e')]), 'an edge points at a missing node'),
        ({'schema': SCHEMA, 'nodes': [START, _node('x', 'handoff')]}, 'a workflow needs an end node'),
        (_definition(loops=['s']), 'every loop must be an object'),
        (_definition(loops=[_loop([])]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['ghost'])]), 'loop 1 is malformed'),
        (_definition(loops=[_loop([7])]), 'loop 1 is malformed'),
        (_definition(loops=[_loop('s')]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s'], until='forever')]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s'], max_rounds=0)]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s'], max_rounds=6)]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s'], max_rounds=True)]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s'], max_rounds='2')]), 'loop 1 is malformed'),
        (_definition(loops=[_loop(['s']), _loop(['e'], max_rounds=0)]), 'loop 2 is malformed'),
    ])
    def test_the_message(self, definition: Any, message: str):
        with pytest.raises(WorkflowError) as exc:
            WorkflowGraph(definition)
        assert str(exc.value) == message

    def test_an_unknown_node_lookup(self):
        with pytest.raises(WorkflowError) as exc:
            WorkflowGraph(_definition()).node('ghost')
        assert str(exc.value) == 'unknown node ghost'


class TestTheAcceptedSideOfEveryBound:
    def test_two_nodes_walk(self):
        graph = WorkflowGraph({'schema': SCHEMA, 'nodes': [START, END]})
        assert graph.start.id == 's'
        assert set(graph.nodes) == {'s', 'e'}

    def test_sixty_nodes_walk(self):
        assert MAX_NODES == workflow_schema.MAX_NODES == 60
        assert len(WorkflowGraph(_definition(*_filler(58))).nodes) == 60

    @pytest.mark.parametrize('rounds', [1, 5])
    def test_round_bounds_are_inclusive(self, rounds: int):
        assert MAX_LOOP_ROUNDS == workflow_schema.MAX_ROUNDS == 5
        graph = WorkflowGraph(_definition(loops=[_loop(['s'], max_rounds=rounds)]))
        assert graph.loops[0].max_rounds == rounds

    def test_an_id_is_cut_at_64_characters(self):
        long_id = 'x' * 65
        graph = WorkflowGraph(_definition(_node(long_id, 'handoff'), edges=[_edge('s', long_id[:64])]))
        assert set(graph.nodes) == {'s', 'e', 'x' * 64}
        assert _ids(graph, 's', None) == ['x' * 64]

    def test_title_and_instructions_are_stripped_and_cut(self):
        node = WorkflowGraph(_definition(
            _node('n', 'handoff', title=' ' + 't' * 201, instructions='i' * 8001 + ' '),
        )).node('n')
        assert node.title == 't' * 200
        assert node.instructions == 'i' * 8000

    def test_missing_text_falls_back(self):
        node = WorkflowGraph(_definition(_node('n', 'write_prd', title='  ', instructions=7, params=[]))).node('n')
        assert node == Node(id='n', type='write_prd', title='write_prd', instructions='', role='worker', params={})

    def test_params_are_copied(self):
        params = {'target': 'prd'}
        node = WorkflowGraph(_definition(_node('n', 'revise_document', params=params))).node('n')
        params['target'] = 'prfaq'
        assert node.params == {'target': 'prd'}


class TestVocabularyTables:
    @pytest.mark.parametrize('node_type', workflow_schema.NODE_TYPES)
    def test_every_node_type_walks_with_a_known_role(self, node_type: str):
        node_id = BUILTIN_IDS.get(node_type, node_type)
        extra = [] if node_id in BUILTIN_IDS.values() else [_node(node_id, node_type)]
        node = WorkflowGraph(_definition(*extra)).node(node_id)
        assert node.type == node_type
        assert node.role in workflow_schema.ROLES

    @pytest.mark.parametrize(('role', 'node_types'), [
        ('orchestrator', {'start', 'end', 'select_or_create_project', 'select_personas', 'duplicate_document',
                          'handoff'}),
        ('worker', {'aggregate_reviews', 'generate_personas', 'deep_research', 'write_prfaq', 'write_prd',
                    'revise_document', 'build_prototype', 'collect_prototype_feedback', 'revise_prototype',
                    'custom_llm'}),
        ('reviewer', {'final_review'}),
        ('persona', {'persona_review'}),
    ])
    def test_the_default_role_of_each_type(self, role: str, node_types: set[str]):
        graph = WorkflowGraph(_definition(*[_node(t, t) for t in node_types - set(BUILTIN_IDS)]))
        assert {n.id for n in graph.nodes.values() if n.role == role} == {BUILTIN_IDS.get(t, t) for t in node_types}

    @pytest.mark.parametrize(('role', 'node_type'), [
        # Each role is set on a type whose default is a different role, so a fallback shows.
        ('orchestrator', 'custom_llm'), ('worker', 'handoff'), ('reviewer', 'handoff'), ('persona', 'handoff'),
    ])
    def test_an_explicit_role_is_honoured(self, role: str, node_type: str):
        assert WorkflowGraph(_definition(_node('n', node_type, role=role))).node('n').role == role

    @pytest.mark.parametrize('role', [None, 7, 'root', 'XXworkerXX'])
    def test_an_unknown_role_falls_back(self, role: Any):
        assert WorkflowGraph(_definition(_node('n', 'handoff', role=role))).node('n').role == 'orchestrator'

    @pytest.mark.parametrize('label', workflow_schema.EDGE_LABELS)
    def test_every_edge_label_routes_its_outcome(self, label: str):
        graph = WorkflowGraph(_definition(_node('n', 'handoff'), edges=[_edge('s', 'e', label), _edge('s', 'n')]))
        assert graph.edges[0] == Edge(source='s', target='e', label=label)
        assert _ids(graph, 's', label) == ['e']
        assert _ids(graph, 's', None) == ['n']
        assert _ids(graph, 's', 'XX' + label + 'XX') == ['n']

    @pytest.mark.parametrize('until', workflow_schema.LOOP_UNTIL)
    def test_every_loop_kind_is_declared(self, until: str):
        graph = WorkflowGraph(_definition(loops=[_loop(['s'], until=until), _loop(['e'], until=until)]))
        assert graph.loops == [
            Loop(index=0, node_ids=frozenset({'s'}), until=until, max_rounds=2),
            Loop(index=1, node_ids=frozenset({'e'}), until=until, max_rounds=2),
        ]

    def test_the_failing_outcomes_are_the_two_negative_labels(self):
        assert frozenset({'fail', 'not_agreed'}) == FAILING_OUTCOMES


class TestWalking:
    def test_fan_out_keeps_edge_order_and_drops_repeats(self):
        graph = WorkflowGraph(_definition(_node('a', 'handoff'), _node('b', 'handoff'), edges=[
            _edge('s', 'b'), _edge('s', 'a'), _edge('s', 'b'), _edge('s', 'e', 'pass'),
        ]))
        assert _ids(graph, 's', None) == ['b', 'a']
        assert _ids(graph, 's', 'pass') == ['e']
        assert _ids(graph, 'e', None) == []

    def test_forward_predecessors_skip_only_loop_mates(self):
        graph = WorkflowGraph(_definition(_node('r', 'final_review'), _node('x', 'revise_document'), edges=[
            _edge('s', 'r'), _edge('r', 'x', 'fail'), _edge('x', 'r'), _edge('r', 'e', 'pass'),
        ], loops=[_loop(['r', 'x'])]))
        assert graph.forward_predecessors('r') == {'s'}
        assert graph.forward_predecessors('x') == set()
        assert graph.forward_predecessors('e') == {'r'}

    @pytest.mark.parametrize(('until', 'gated', 'held'), [
        ('review_pass', 'r', 'p'),
        ('persona_agreement', 'p', 'r'),
    ])
    def test_a_loop_gates_on_one_kind_of_node(self, until: str, gated: str, held: str):
        graph = WorkflowGraph(_definition(_node('r', 'final_review'), _node('p', 'persona_review'),
                                          _node('o', 'handoff'), loops=[_loop(['r', 'p'], until=until)]))
        assert graph.gating_loop(graph.node(gated)) == graph.loops[0]
        assert graph.gating_loop(graph.node(held)) is None
        assert graph.gating_loop(graph.node('o')) is None


class TestRecordsAreFrozen:
    @pytest.mark.parametrize('record', [
        Node(id='n', type='handoff', title='t', instructions='', role='worker'),
        Edge(source='s', target='e', label=None),
        Loop(index=0, node_ids=frozenset(), until='review_pass', max_rounds=1),
    ])
    def test_a_field_cannot_be_reassigned(self, record: Any):
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(record, dataclasses.fields(record)[0].name, 'other')

    def test_params_default_to_an_empty_dict(self):
        assert Node(id='n', type='handoff', title='t', instructions='', role='worker').params == {}
