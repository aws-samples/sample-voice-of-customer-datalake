"""The shared fixture of engineering flows (frontend/src/test/engineeringFlows.json) holds the server's answers.

The editor's port of the rules (frontend WorkflowEditor/engineeringRules.ts) is tested against the same file, so the
two give the same errors for every case. When a rule changes, rewrite the file and look at the diff:
``python -m shared.test.test_engineering_flow_fixture`` from voc-datalake/lambda.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from shared.test.test_workflow_engineering import _middle, arrow, bug_fix, flow, gate_edges, node, understand
from shared.workflow_schema import SCHEMA, validate_definition

FIXTURE = Path(__file__).resolve().parents[3] / 'frontend' / 'src' / 'test' / 'engineeringFlows.json'


def _bug_fix_with(**changes: Any) -> dict[str, Any]:
    definition = bug_fix()
    hunt = definition['nodes'][1]['data']['params']
    hunt.update(changes)
    return definition


def _gate_with(**changes: Any) -> dict[str, Any]:
    definition = bug_fix()
    gate = next(item for item in definition['nodes'] if item['id'] == 'gate')['data']['params']
    gate.update(changes)
    return definition


def _step(kind: str, **params: Any) -> dict[str, Any]:
    return flow([node('start', 'start'), node('step', kind, **params), node('end', 'end')],
                [arrow('start', 'step'), arrow('step', 'end')])


def corpus() -> list[tuple[str, dict[str, Any]]]:
    """Valid flows, and one break of each rule (each case's errors are the server's answer)."""
    reaches_done = bug_fix()
    reaches_done['nodes'].append(node('done', 'end'))
    reaches_done['edges'].insert(2, arrow('board', 'done'))
    after_stop = bug_fix()
    after_stop['nodes'].append(node('after', 'end'))
    after_stop['edges'].append(arrow('pr', 'after'))
    labelled = bug_fix()
    labelled['edges'][1] = arrow('hunt', 'board', 'pass')
    looped = bug_fix()
    looped['loops'] = [{'node_ids': ['hunt'], 'until': 'review_pass', 'max_rounds': 2}]
    roled = copy.deepcopy(bug_fix())
    roled['nodes'][1]['data']['role'] = 'worker'
    shares = bug_fix()
    shares['nodes'][1]['data']['params']['budget_share'] = 0.1
    shares['nodes'][2:2] = [node('fix', 'agent', role='fixer', budget_share=0.2),
                            node('build', 'agent', role='builder', budget_share=0.7)]
    shares['edges'] = [arrow('start', 'hunt'), arrow('hunt', 'fix'), arrow('fix', 'build'), arrow('build', 'board'),
                       *shares['edges'][2:]]
    over = copy.deepcopy(shares)
    over['nodes'][3]['data']['params']['budget_share'] = 0.8
    return [
        ('a bug fix that ends at a PR', bug_fix()),
        ('shares that make the whole budget', shares),
        ('shares over the budget', over),
        ('understand: map, reduce, memory, learning', understand()),
        ('self-improvement alone', flow(
            [node('start', 'start'), node('coach', 'self_improvement'), node('end', 'end')],
            [arrow('start', 'coach'), arrow('coach', 'end')])),
        ('an agent with no role', _step('agent')),
        ('a bad skill version', _step('agent', role='fixer', skill_version='v0')),
        ('a null skill version (given, so refused)', _step('agent', role='fixer', skill_version=None)),
        ('a null share (read as none set)', _bug_fix_with(budget_share=None)),
        ('a share of 0', _bug_fix_with(budget_share=0)),
        ('a map with no shard rule', _step('map')),
        ('a shard cap too high', _step('map', shard_by='history', shard_cap=201)),
        ('a board poster that may not post', _step('board', posters=['fixer'], claimers=['fixer'])),
        ('a board claimer with no queue', _step('board', posters=['hunter'], claimers=['coach'])),
        ('a board that never ends', _step('board', posters=['hunter'], claimers=['fixer'], until='never')),
        ('a board with a null end', _step('board', posters=['hunter'], claimers=['fixer'], until=None)),
        ('a gate reviewer with a null advisory', _step('quality_gate', reviewers=[
            {'name': 'security', 'advisory': None}])),
        ('a gate with six rounds', _step('quality_gate', max_rounds=6)),
        ('a gate with an unknown pack', _step('quality_gate', packs=['cobol'])),
        ('a gate with an unknown setting', _step('quality_gate', colour='red')),
        ('a gate whose reviewers are all advisory', _step('quality_gate', reviewers=[{'name': 'first-principles'}])),
        ('a memory step with no mode', _step('memory', scope='repo')),
        ('a memory read with too many', _step('memory', mode='read', scope='repo', limit=51)),
        ('a committer that can end at a plain end', reaches_done),
        ('a stop at PR with an arrow out', after_stop),
        ('a gate with no fail arrow', gate_edges(arrow('gate', 'pr', 'pass'))),
        ('a gate whose fail arrow goes to the PR', gate_edges(arrow('gate', 'pr', 'pass'), arrow('gate', 'pr', 'fail'))),
        ('a label on an agent arrow', labelled),
        ('a learning loop in the middle', _middle('learning_loop')),
        ('self-improvement in the middle', _middle('self_improvement')),
        ('a map with no reduce', flow([node('start', 'start'), node('map', 'map', shard_by='packages'),
                                      node('end', 'end')], [arrow('start', 'map'), arrow('map', 'end')])),
        ('a map with a way around its reduce', flow(
            [node('start', 'start'), node('map', 'map', shard_by='packages'), node('reduce', 'reduce'),
             node('end', 'end')],
            [arrow('start', 'map'), arrow('map', 'reduce'), arrow('map', 'end'), arrow('reduce', 'end')])),
        ('a reduce with no map', flow([node('start', 'start'), node('reduce', 'reduce'), node('end', 'end')],
                                      [arrow('start', 'reduce'), arrow('reduce', 'end')])),
        ('an agents step in an engineering flow', flow(
            [node('start', 'start'), node('prd', 'write_prd'), node('end', 'end')],
            [arrow('start', 'prd'), arrow('prd', 'end')])),
        ('an engineering step in an agents workflow', flow(
            [node('start', 'start'), node('fix', 'agent', role='fixer'), node('end', 'end')],
            [arrow('start', 'fix'), arrow('fix', 'end')], schema=SCHEMA)),
        ('a loop in an engineering flow', looped),
        ('a step role in an engineering flow', roled),
        # (7.52.00: a call of another saved flow, and an agent from a Registry card)
        ('a call of a saved flow at its revision', _step('call_flow', flow='wf_0123456789ab@3', budget_share=0.5,
                                                         inputs={'issue': "the run's issue"})),
        ('a call with no revision', _step('call_flow', flow='wf_0123456789ab')),
        ('a call of no flow', _step('call_flow')),
        ('a call with an unknown setting', _step('call_flow', flow='wf_0123456789ab@3', colour='red')),
        ('a call with assertions', _step('call_flow', flow='wf_0123456789ab@3', **{'assert': []})),
        ('a call with too many inputs', _step('call_flow', flow='wf_0123456789ab@3',
                                              inputs={f'input_{n}': 'x' for n in range(11)})),
        ('a call input that is not text', _step('call_flow', flow='wf_0123456789ab@3', inputs={'issue': 12})),
        ('a call with a share of 0', _step('call_flow', flow='wf_0123456789ab@3', budget_share=0)),
        ('a call and an agent over the budget', flow(
            [node('start', 'start'), node('hunt', 'agent', role='hunter', budget_share=0.6),
             node('call', 'call_flow', flow='wf_0123456789ab@3', budget_share=0.5), node('end', 'end')],
            [arrow('start', 'hunt'), arrow('hunt', 'call'), arrow('call', 'end')])),
        ('an agent from a Registry card', _step('agent', role='fixer', skill_version='v3', card='fixer-python@v2')),
        ('an agent from a card at latest', _step('agent', role='fixer', card='fixer-python@v2')),
        ('an agent with a bad card', _step('agent', role='fixer', skill_version='v3', card='fixer python')),
        # (7.52.00: who runs a gate, an assertion's place, a flow's inputs)
        ('a gate run by cards and its own assertions', _gate_with(
            runner='gate-runner-strict@v2', final_go='final-go@v3',
            **{'assert': [{'check': 'gate.passed', 'on_fail': 'fail_arrow'}, {'check': 'gate.pack_checks_ran'}]})),
        ('a gate run by another role', _gate_with(runner='fixer@latest')),
        ('a gate card at latest', _gate_with(final_go='final-go-strict@latest')),
        ("a gate's assertion on an agent", _bug_fix_with(**{'assert': [{'check': 'gate.passed'}]})),
        ('fail_arrow on an agent', _bug_fix_with(**{'assert': [
            {'check': 'findings.cite_evidence', 'on_fail': 'fail_arrow'}]})),
        ('an unknown assertion', _bug_fix_with(**{'assert': [{'check': 'tests.green'}]})),
        ('an assertion without its arguments', _bug_fix_with(**{'assert': [{'check': 'tasks.posted'}]})),
        ('an assertion with a bad on_fail', _bug_fix_with(**{'assert': [{'check': 'tasks.posted', 'on_fail': 'stop',
                                                                          'args': {'role': 'fixer', 'min': 1}}]})),
        ('too many assertions', _bug_fix_with(**{'assert': [{'check': 'findings.cite_evidence'}] * 11})),
        ('an assertion on a map', _step('map', shard_by='packages', **{'assert': [{'check': 'notes.cite_sources'}]})),
        ('a flow with its inputs', {**bug_fix(), 'inputs': {'issue': {'type': 'issue_ref', 'required': True},
                                                            'feedback': {'type': 'feedback_ids', 'max': 50}}}),
    ]


def expected() -> list[dict[str, Any]]:
    return [{'name': name, 'definition': definition,
             'errors': [issue.to_dict() for issue in validate_definition(definition).errors]}
            for name, definition in corpus()]


def test_the_fixture_holds_the_servers_answers() -> None:
    assert json.loads(FIXTURE.read_text(encoding='utf-8')) == expected(), (
        'rewrite it: python -m shared.test.test_engineering_flow_fixture (from voc-datalake/lambda)')


def test_the_corpus_covers_valid_flows_and_broken_ones() -> None:
    answers = expected()
    assert sum(not case['errors'] for case in answers) >= 4
    assert sum(bool(case['errors']) for case in answers) >= 25


if __name__ == '__main__':
    FIXTURE.write_text(json.dumps(expected(), indent=1) + '\n', encoding='utf-8')
