"""The workflow graph walker and the voc-agent-run definition."""
from __future__ import annotations

import json

from agents import state_machine
from agents.graph import WorkflowGraph
from shared.workflow_schema import default_template as default_workflow


def _next_ids(graph: WorkflowGraph, node_id: str, outcome: str | None) -> list[str]:
    return [n.id for n in graph.next_nodes(node_id, outcome)]


class TestDefaultTemplate:
    def test_parses_and_walks(self):
        graph = WorkflowGraph(default_workflow())

        assert _next_ids(graph, 'start', None) == ['aggregate']
        assert _next_ids(graph, 'prfaq_review', 'agreed') == ['prototype']
        assert _next_ids(graph, 'prfaq_review', 'not_agreed') == ['prfaq_revise']
        assert _next_ids(graph, 'prfaq_revise', None) == ['prfaq_review']
        assert _next_ids(graph, 'final_review', 'pass') == ['handoff']
        assert _next_ids(graph, 'final_review', 'fail') == ['needs_human']

    def test_the_project_step_fans_out_and_the_prfaq_joins(self):
        graph = WorkflowGraph(default_workflow())

        assert {n.id for n in graph.next_nodes('project', None)} == {'personas_fixed', 'personas_new', 'research'}
        assert graph.forward_predecessors('prfaq') == {'personas_fixed', 'personas_new', 'research'}
        # A loop's own back edge never holds its review.
        assert graph.forward_predecessors('prfaq_review') == {'prfaq'}

    def test_loops_gate_on_their_persona_review(self):
        graph = WorkflowGraph(default_workflow())

        prfaq_loop = graph.gating_loop(graph.node('prfaq_review'))
        prototype_loop = graph.gating_loop(graph.node('prototype_review'))
        assert prfaq_loop is not None
        assert prfaq_loop.max_rounds == 3
        assert prototype_loop is not None
        assert prototype_loop.max_rounds == 2
        assert graph.gating_loop(graph.node('prfaq_revise')) is None
        assert graph.gating_loop(graph.node('final_review')) is None

    def test_default_copies_are_independent(self):
        first = default_workflow()
        first['nodes'].clear()
        assert default_workflow()['nodes']

    def test_default_roles_and_params(self):
        graph = WorkflowGraph(default_workflow())

        assert graph.node('final_review').role == 'reviewer'
        assert graph.node('project').role == 'orchestrator'
        assert graph.node('prototype_review').params == {'target': 'prototype'}


def _custom_step_flow(edges: list[dict]) -> dict:
    """start → aggregate → custom step → end, with the custom step's arrows as given."""
    return {
        'schema': 'voc-workflow/1', 'name': 'flow',
        'nodes': [
            {'id': 'start', 'type': 'start', 'position': {'x': 0, 'y': 0}, 'data': {'title': 'Start'}},
            {'id': 'agg', 'type': 'aggregate_reviews', 'position': {'x': 0, 'y': 1}, 'data': {'title': 'Agg'}},
            {'id': 'custom', 'type': 'custom_llm', 'position': {'x': 0, 'y': 2},
             'data': {'title': 'Custom', 'instructions': 'Summarise.'}},
            {'id': 'end', 'type': 'end', 'position': {'x': 0, 'y': 3}, 'data': {'title': 'Done'}},
            {'id': 'human', 'type': 'end', 'position': {'x': 1, 'y': 3},
             'data': {'title': 'Human', 'params': {'status': 'needs_human'}}},
        ],
        'edges': [{'id': 'e1', 'source': 'start', 'target': 'agg'}, {'id': 'e2', 'source': 'agg', 'target': 'custom'}, *edges],
        'loops': [],
    }


class TestCustomStepArrowsReadAsPlain:
    """A custom step reports no verdict. Pre-3.00.00 workflows could still label its arrows
    pass/fail (E2E s2 F4: the editor pre-labelled the first one `pass`); the walker reads
    them as the plain arrows the runtime always took, so such a run never fails on them."""

    def test_a_lone_pass_arrow_is_the_next_step(self):
        graph = WorkflowGraph(_custom_step_flow([{'id': 'e3', 'source': 'custom', 'target': 'end', 'label': 'pass'}]))
        assert _next_ids(graph, 'custom', None) == ['end']
        assert [(e.target, e.label) for e in graph.edges if e.source == 'custom'] == [('end', None)]

    def test_the_dead_fail_arrow_is_dropped_not_revived(self):
        graph = WorkflowGraph(_custom_step_flow([
            {'id': 'e3', 'source': 'custom', 'target': 'end', 'label': 'pass'},
            {'id': 'e4', 'source': 'custom', 'target': 'human', 'label': 'fail'},
        ]))
        # Before: no outcome took `pass` only. Turning `fail` into a plain arrow would
        # have fanned out to `human` as well.
        assert _next_ids(graph, 'custom', None) == ['end']
        assert [(e.target, e.label) for e in graph.edges if e.source == 'custom'] == [('end', None)]

    def test_an_unlabelled_arrow_stays_the_default_and_shadows_pass(self):
        graph = WorkflowGraph(_custom_step_flow([
            {'id': 'e3', 'source': 'custom', 'target': 'human'},
            {'id': 'e4', 'source': 'custom', 'target': 'end', 'label': 'pass'},
        ]))
        assert _next_ids(graph, 'custom', None) == ['human']

    def test_a_final_review_keeps_its_verdict_arrows(self):
        graph = WorkflowGraph(default_workflow())
        assert _next_ids(graph, 'final_review', 'fail') == ['needs_human']


def test_unknown_roles_fall_back_and_unknown_labels_are_defaults():
    definition = default_workflow()
    definition['nodes'][1]['data']['role'] = 'root'
    definition['edges'][0]['label'] = 'maybe'
    graph = WorkflowGraph(definition)

    assert graph.node('aggregate').role == 'worker'
    assert _next_ids(graph, 'start', 'whatever') == ['aggregate']


class TestStateMachine:
    def test_committed_asl_matches_the_builder(self):
        assert state_machine.ASL_PATH.read_text(encoding='utf-8') == state_machine.render()

    def test_every_transition_names_a_state(self):
        definition = state_machine.build_definition()
        states = definition['States']
        targets = {definition['StartAt']}
        for state in states.values():
            targets.update(filter(None, [state.get('Next'), state.get('Default')]))
            targets.update(c['Next'] for c in state.get('Choices', []))
            targets.update(c['Next'] for c in state.get('Catch', []))
        assert targets <= set(states)

    def test_only_the_three_substitutions_are_used(self):
        text = state_machine.render()
        import re
        assert set(re.findall(r'\$\{(\w+)\}', text)) == {
            'ConductorFunctionArn', 'NodesFunctionArn', 'PersonaPanelFunctionArn'}

    def test_persona_review_routes_to_the_panel(self):
        route = state_machine.build_definition()['States']['Route']
        first = route['Choices'][0]
        assert first['Next'] == 'PersonaPanel'
        assert {'Variable': '$.step.next.node_type', 'StringEquals': 'persona_review'} in first['And']

    def test_every_task_except_the_failure_recorder_is_caught(self):
        for name, state in state_machine.build_definition()['States'].items():
            if state['Type'] == 'Task':
                assert ('Catch' in state) == (name != 'RecordFailure'), name

    def test_definition_is_plain_json(self):
        assert json.loads(state_machine.render())['TimeoutSeconds'] == state_machine.TIMEOUT_SECONDS
