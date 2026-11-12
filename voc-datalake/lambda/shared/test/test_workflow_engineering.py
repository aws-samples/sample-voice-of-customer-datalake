"""Engineering flows (voc-workflow/2): each step's settings and each rule of plan v3 4.9, through validate_definition."""
from __future__ import annotations

import copy
from typing import Any

import pytest

from shared.workflow_schema import SCHEMA, SCHEMA_V2, validate_definition


def node(node_id: str, kind: str, **params: Any) -> dict[str, Any]:
    return {'id': node_id, 'type': kind, 'position': {'x': 0, 'y': 0}, 'data': {'title': node_id, 'params': params}}


def arrow(source: str, target: str, label: str | None = None) -> dict[str, Any]:
    return {'id': f'{source}-{target}-{label or ""}', 'source': source, 'target': target,
            **({'label': label} if label else {})}


def flow(nodes: list[dict[str, Any]], edges: list[dict[str, Any]], **changes: Any) -> dict[str, Any]:
    return {'schema': SCHEMA_V2, 'name': 'Bug hunt and fix', 'nodes': nodes, 'edges': edges, 'loops': [], **changes}


def bug_fix() -> dict[str, Any]:
    """start -> hunter -> board (hunter posts, fixer/committer claim) -> gate -> stop at PR | human."""
    return flow([node('start', 'start'), node('hunt', 'agent', role='hunter', budget_share=0.3),
                 node('board', 'board', posters=['hunter'], claimers=['fixer', 'committer']),
                 node('gate', 'quality_gate', max_rounds=3, packs='auto'), node('pr', 'stop_at_pr'),
                 node('human', 'end', status='needs_human')],
                [arrow('start', 'hunt'), arrow('hunt', 'board'), arrow('board', 'gate'),
                 arrow('gate', 'pr', 'pass'), arrow('gate', 'human', 'fail')])


def errors(definition: dict[str, Any]) -> list[tuple[str, str | None]]:
    return [(issue.message, issue.node_id) for issue in validate_definition(definition).errors]


def test_a_bug_fix_flow_that_ends_at_a_pr_is_valid() -> None:
    result = validate_definition(bug_fix())
    assert result.valid, result.errors
    assert result.definition is not None
    assert result.definition['schema'] == SCHEMA_V2


def test_a_map_reduce_understand_flow_with_a_learning_loop_needs_no_stop_at_pr() -> None:
    understand = flow([node('start', 'start'), node('map', 'map', shard_by='packages', shard_cap=50),
                       node('read', 'agent', role='mapper'), node('reduce', 'reduce'),
                       node('memory', 'memory', mode='write', scope='repo'), node('learn', 'learning_loop'),
                       node('end', 'end')],
                      [arrow('start', 'map'), arrow('map', 'read'), arrow('read', 'reduce'), arrow('reduce', 'memory'),
                       arrow('memory', 'learn'), arrow('learn', 'end')])
    assert errors(understand) == []


def test_self_improvement_alone_in_its_flow() -> None:
    coach = flow([node('start', 'start'), node('memory', 'memory', mode='read', scope='role', limit=20),
                  node('coach', 'self_improvement'), node('memory2', 'memory', mode='write', scope='role'),
                  node('end', 'end')],
                 [arrow('start', 'memory'), arrow('memory', 'coach'), arrow('coach', 'memory2'),
                  arrow('memory2', 'end')])
    assert errors(coach) == []


ROLES = ('mapper, understander, hunter, fixer, builder, committer, commit-reviewer, gate-runner, pr-author, '
         'pr-reviewer, final-go, coordinator, coach')
POSTERS = 'builder, coordinator, hunter'
CLAIMERS = ('builder, commit-reviewer, committer, final-go, fixer, hunter, mapper, pr-author, pr-reviewer, '
            'understander')
SHARE = "an agent's params.budget_share is a fraction of the run's budget, above 0 and at most 1"
PACKS = "a quality gate's params.packs is 'auto' or a list of gate packs: java, python-ts, rust-ts"
FINAL_GO_MODEL = "a quality gate's params.final_go_model is a model id of at most 128 characters"
GATE_ARROWS = "a quality gate needs a 'pass' arrow (GO) and a 'fail' arrow (NO-GO), every arrow labelled"
GATE_FAIL = "a quality gate's 'fail' arrow goes to a human decision point (an end step that needs a human)"


@pytest.mark.parametrize(('kind', 'params', 'message'), [
    ('agent', {'role': 'wizard'}, f'an agent needs params.role: one of {ROLES}'),
    ('agent', {'role': 'fixer', 'skill_version': 'v0'}, "an agent's params.skill_version is 'latest' or a version like 'v3'"),
    ('agent', {'role': 'fixer', 'model': ''}, "an agent's params.model is a model id of at most 128 characters"),
    ('agent', {'role': 'fixer', 'budget_share': 0}, SHARE),
    ('agent', {'role': 'fixer', 'budget_share': True}, SHARE),
    ('map', {'shard_by': 'files'}, 'a map needs params.shard_by: one of packages, history, pr_pages'),
    ('map', {'shard_by': 'history', 'shard_cap': 201}, "a map's params.shard_cap is a whole number from 1 to 200"),
    ('board', {'posters': [], 'claimers': ['fixer']}, f'a board needs params.posters: a list of roles, each once ({POSTERS})'),
    ('board', {'posters': ['fixer'], 'claimers': ['fixer']},
     f'a board needs params.posters: a list of roles, each once ({POSTERS})'),
    ('board', {'posters': ['hunter'], 'claimers': ['fixer', 'fixer']},
     f'a board needs params.claimers: a list of roles, each once ({CLAIMERS})'),
    ('board', {'posters': ['hunter'], 'claimers': ['coach']},
     f'a board needs params.claimers: a list of roles, each once ({CLAIMERS})'),
    ('board', {'posters': ['hunter'], 'claimers': ['fixer'], 'until': 'never'},
     "a board's params.until is one of drained, caps"),
    ('quality_gate', {'max_rounds': 6}, "a quality gate's params.max_rounds is a whole number from 1 to 5"),
    ('quality_gate', {'packs': ['cobol']}, PACKS),
    ('quality_gate', {'final_go_model': 'x' * 129}, FINAL_GO_MODEL),
    ('memory', {'mode': 'erase', 'scope': 'repo'}, 'a memory step needs params.mode: one of read, write'),
    ('memory', {'mode': 'read', 'scope': 'team'}, 'a memory step needs params.scope: one of repo, role, person'),
    ('memory', {'mode': 'read', 'scope': 'repo', 'limit': 51}, "a memory read's params.limit is a whole number from 1 to 50"),
])
def test_a_step_with_bad_settings_names_what_to_change(kind: str, params: dict[str, Any], message: str) -> None:
    definition = flow([node('start', 'start'), node('step', kind, **params), node('end', 'end')],
                      [arrow('start', 'step'), arrow('step', 'end')])
    assert (message, 'step') in errors(definition)


def test_the_agents_shares_stay_within_the_run_budget() -> None:
    definition = bug_fix()
    definition['nodes'].insert(2, node('fix', 'agent', role='fixer', budget_share=0.8))
    definition['edges'] = [arrow('start', 'hunt'), arrow('hunt', 'fix'), arrow('fix', 'board'),
                           *definition['edges'][2:]]
    assert errors(definition) == [("the agents' budget shares add up to more than the run's budget (at most 1 in all)",
                                   None)]


def test_shares_that_make_the_whole_budget_are_fine() -> None:
    definition = bug_fix()
    definition['nodes'][1]['data']['params']['budget_share'] = 0.1
    definition['nodes'][2:2] = [node('fix', 'agent', role='fixer', budget_share=0.2),
                                node('build', 'agent', role='builder', budget_share=0.7)]
    definition['edges'] = [arrow('start', 'hunt'), arrow('hunt', 'fix'), arrow('fix', 'build'), arrow('build', 'board'),
                           *definition['edges'][2:]]
    assert errors(definition) == []


def test_a_committer_must_end_at_a_stop_at_pr() -> None:
    reaches_done = bug_fix()
    reaches_done['nodes'].append(node('done', 'end'))
    reaches_done['edges'] = [*reaches_done['edges'][:2], arrow('board', 'done'), *reaches_done['edges'][2:]]
    message = ('a committer or PR author ends the flow at a stop at PR: every way its work can end is a stop at PR '
               'or a human decision point, and at least one is a stop at PR')
    assert errors(reaches_done) == [(message, 'board')]
    only_human = flow([node('start', 'start'), node('commit', 'agent', role='committer'),
                       node('human', 'end', status='needs_human')],
                      [arrow('start', 'commit'), arrow('commit', 'human')])
    assert errors(only_human) == [(message, 'commit')]


def test_a_stop_at_pr_ends_the_flow() -> None:
    definition = bug_fix()
    definition['nodes'].append(node('after', 'end'))
    definition['edges'].append(arrow('pr', 'after'))
    assert ('a stop at PR ends the flow: no arrow leaves it', 'pr') in errors(definition)


@pytest.mark.parametrize(('edges', 'expected'), [
    ([arrow('gate', 'pr', 'pass')], GATE_ARROWS),
    ([arrow('gate', 'pr', 'pass'), arrow('gate', 'human')], GATE_ARROWS),
    ([arrow('gate', 'pr', 'pass'), arrow('gate', 'pr', 'fail')], GATE_FAIL),
])
def test_a_gate_goes_to_the_pr_on_go_and_to_a_person_on_no_go(edges: list[dict[str, Any]], expected: str) -> None:
    definition = bug_fix()
    definition['edges'] = [*definition['edges'][:3], *edges]
    if not any(edge['target'] == 'human' for edge in edges):   # an end no arrow reaches is another error
        definition['nodes'] = [n for n in definition['nodes'] if n['id'] != 'human']
    assert (expected, 'gate') in errors(definition)


def test_only_a_gate_labels_its_arrows() -> None:
    definition = bug_fix()
    definition['edges'][1] = arrow('hunt', 'board', 'pass')
    assert ("only a quality gate's arrows carry a label (pass or fail)", 'hunt') in errors(definition)


@pytest.mark.parametrize(('builder', 'message'), [
    (lambda: _middle('learning_loop'), 'a learning loop is the last step before an end, or comes right after a board'),
    (lambda: _middle('self_improvement'), 'self-improvement runs in its own flow, or as the last step before an end'),
])
def test_learning_and_self_improvement_sit_where_the_plan_puts_them(builder: Any, message: str) -> None:
    assert (message, 'step') in errors(builder())


def _middle(kind: str) -> dict[str, Any]:
    return flow([node('start', 'start'), node('step', kind), node('fix', 'agent', role='fixer'), node('end', 'end')],
                [arrow('start', 'step'), arrow('step', 'fix'), arrow('fix', 'end')])


def test_a_learning_loop_right_after_a_board_is_fine() -> None:
    definition = flow([node('start', 'start'), node('board', 'board', posters=['hunter'], claimers=['fixer']),
                       node('learn', 'learning_loop'), node('fix', 'agent', role='fixer'), node('end', 'end')],
                      [arrow('start', 'board'), arrow('board', 'learn'), arrow('learn', 'fix'), arrow('fix', 'end')])
    assert errors(definition) == []


MAP = 'a map needs exactly one reduce after it, on every way out, where its shards meet'


@pytest.mark.parametrize(('nodes', 'edges', 'expected'), [
    ([node('start', 'start'), node('map', 'map', shard_by='packages'), node('end', 'end')],
     [arrow('start', 'map'), arrow('map', 'end')], [(MAP, 'map')]),
    ([node('start', 'start'), node('map', 'map', shard_by='packages'), node('a', 'reduce'), node('b', 'reduce'),
      node('end', 'end')],
     [arrow('start', 'map'), arrow('map', 'a'), arrow('map', 'b'), arrow('a', 'end'), arrow('b', 'end')],
     [(MAP, 'map')]),
    ([node('start', 'start'), node('map', 'map', shard_by='packages'), node('reduce', 'reduce'), node('end', 'end')],
     [arrow('start', 'map'), arrow('map', 'reduce'), arrow('map', 'end'), arrow('reduce', 'end')], [(MAP, 'map')]),
    ([node('start', 'start'), node('reduce', 'reduce'), node('end', 'end')],
     [arrow('start', 'reduce'), arrow('reduce', 'end')], [('a reduce needs a map before it', 'reduce')]),
])
def test_every_map_reaches_exactly_one_reduce(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                                              expected: list[tuple[str, str]]) -> None:
    assert errors(flow(nodes, edges)) == expected


def test_a_map_whose_shards_take_two_ways_to_one_reduce_is_fine() -> None:
    definition = flow([node('start', 'start'), node('map', 'map', shard_by='history'),
                       node('a', 'agent', role='mapper'), node('b', 'agent', role='understander'),
                       node('reduce', 'reduce'), node('end', 'end')],
                      [arrow('start', 'map'), arrow('map', 'a'), arrow('map', 'b'), arrow('a', 'reduce'),
                       arrow('b', 'reduce'), arrow('reduce', 'end')])
    assert errors(definition) == []


def test_the_two_kinds_of_flow_keep_their_own_steps() -> None:
    agents_step = flow([node('start', 'start'), node('prd', 'write_prd'), node('end', 'end')],
                       [arrow('start', 'prd'), arrow('prd', 'end')])
    assert errors(agents_step) == [("an agents step belongs in an agents workflow (schema 'voc-workflow/1')", 'prd')]
    engineering_step = flow([node('start', 'start'), node('fix', 'agent', role='fixer'), node('end', 'end')],
                            [arrow('start', 'fix'), arrow('fix', 'end')], schema=SCHEMA)
    assert errors(engineering_step) == [("an engineering step belongs in an engineering flow (schema 'voc-workflow/2')",
                                         'fix')]
    assert errors(flow([], [], schema='voc-workflow/3'))[0] == (
        "schema must be 'voc-workflow/1' (an agents workflow) or 'voc-workflow/2' (an engineering flow)", None)


def test_an_engineering_flow_declares_no_loops_and_no_step_roles() -> None:
    looped = bug_fix()
    looped['loops'] = [{'node_ids': ['hunt'], 'until': 'review_pass', 'max_rounds': 2}]
    assert ('an engineering flow repeats through its board, so it declares no loops', None) in errors(looped)
    roled = copy.deepcopy(bug_fix())
    roled['nodes'][1]['data']['role'] = 'worker'
    assert errors(roled) == [("an engineering step takes no data.role (an agent's role is its params.role)", 'hunt')]
