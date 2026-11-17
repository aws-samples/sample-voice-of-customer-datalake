"""A flow's calls, expanded (shared/flow_expand.py, 7.52.00): the called flows spliced in at their pinned revisions.

Depth 2 passes and depth 3 is refused; the 60-step cap counts every call expanded; a flow in its own chain of calls is
a cycle; the shares of a called flow's agents are scaled to the call's; the expanded ids are ``<call>.<step>``, at
most 64 characters; a call reads the revision it pins, never a later one; a called flow that ends at a pull request
needs its call last. The flat flow passes the server's rules, and records its calls on its start step.
"""
from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

import pytest

from shared import flow_expand
from shared.flow_expand import EXPANSION, ExpansionError, expand, save_issues, scaled_share
from shared.test.test_workflow_engineering import arrow, bug_fix, flow, node
from shared.workflow_schema import MAX_NODES, validate_definition

A, B, C, D = 'wf_aaaaaaaaaaaa', 'wf_bbbbbbbbbbbb', 'wf_cccccccccccc', 'wf_dddddddddddd'
ROOT = 'wf_000000000000'


class Saved:
    """The stored flows, by id and revision, as ``revision_reader`` reads them."""

    def __init__(self, **flows: Mapping[str, Any]) -> None:
        self.flows: dict[tuple[str, int], Mapping[str, Any]] = {}
        self.reads: list[tuple[str, int]] = []
        for key, definition in flows.items():
            workflow_id, _, revision = key.rpartition('_r')
            self.flows[(workflow_id, int(revision))] = definition

    def save(self, workflow_id: str, revision: int, definition: Mapping[str, Any]) -> None:
        self.flows[(workflow_id, revision)] = definition

    def __call__(self, workflow_id: str, revision: int) -> Mapping[str, Any] | None:
        self.reads.append((workflow_id, revision))
        found = self.flows.get((workflow_id, revision))
        return copy.deepcopy(found) if found is not None else None


def two_agents(first: float | None = 0.5, second: float | None = 0.5) -> dict[str, Any]:
    """A called flow: start → hunt → fix → done (a plain end)."""
    hunt = {'budget_share': first} if first is not None else {}
    fix = {'budget_share': second} if second is not None else {}
    return flow([node('start', 'start'), node('hunt', 'agent', role='hunter', **hunt),
                 node('fix', 'agent', role='fixer', **fix), node('done', 'end')],
                [arrow('start', 'hunt'), arrow('hunt', 'fix'), arrow('fix', 'done')])


def calling(ref: str, *, share: float | None = None, step: str = 'call', after: str = 'build') -> dict[str, Any]:
    """A caller: start → <call> → <after> (an agent) → end."""
    call = {'flow': ref, **({'budget_share': share} if share is not None else {})}
    return flow([node('start', 'start'), node(step, 'call_flow', **call), node(after, 'agent', role='builder'),
                 node('end', 'end')],
                [arrow('start', step), arrow(step, after), arrow(after, 'end')])


def calling_only(ref: str, step: str = 'call') -> dict[str, Any]:
    """A caller whose call is its last step: start → <call> → end."""
    return flow([node('start', 'start'), node(step, 'call_flow', flow=ref), node('end', 'end')],
                [arrow('start', step), arrow(step, 'end')])


def ids(definition: Mapping[str, Any]) -> list[str]:
    return [item['id'] for item in definition['nodes']]


def arrows(definition: Mapping[str, Any]) -> set[tuple[str, str, str | None]]:
    return {(edge['source'], edge['target'], edge.get('label')) for edge in definition['edges']}


def refusal(definition: Mapping[str, Any], read: Saved, root: str | None = ROOT) -> ExpansionError:
    with pytest.raises(ExpansionError) as refused:
        expand(definition, read, root=root)
    return refused.value


def test_a_call_is_replaced_by_its_flows_steps_spliced_into_the_arrows() -> None:
    expanded = expand(calling(f'{A}@1'), Saved(**{f'{A}_r1': two_agents()}), root=ROOT)
    assert ids(expanded.definition) == ['start', 'call.hunt', 'call.fix', 'build', 'end']
    assert arrows(expanded.definition) == {('start', 'call.hunt', None), ('call.hunt', 'call.fix', None),
                                           ('call.fix', 'build', None), ('build', 'end', None)}
    assert validate_definition(expanded.definition).errors == ()
    # (D4: the run's copy records its calls on its start step, and the answer says them too)
    assert expanded.expansion == ({'step': 'call', 'flow': A, 'revision': 1},)
    assert expanded.definition['nodes'][0]['data']['params'][EXPANSION] == [{'step': 'call', 'flow': A, 'revision': 1}]


def test_a_flow_with_no_call_is_answered_as_it_is() -> None:
    read = Saved()
    expanded = expand(bug_fix(), read, root=ROOT)
    assert expanded.definition == bug_fix()
    assert expanded.expansion == ()
    assert read.reads == []


def test_depth_two_passes_and_depth_three_is_refused() -> None:
    read = Saved(**{f'{A}_r1': calling(f'{B}@1', step='inner', after='mid'), f'{B}_r1': two_agents()})
    expanded = expand(calling(f'{A}@1', step='outer'), read, root=ROOT)
    assert 'outer.inner.hunt' in ids(expanded.definition)
    assert 'outer.mid' in ids(expanded.definition)
    # (the outer call before the one inside it, each named by its full id)
    assert [(call['step'], call['flow']) for call in expanded.expansion] == [('outer', A), ('outer.inner', B)]
    assert validate_definition(expanded.definition).errors == ()

    deeper = Saved(**{f'{A}_r1': calling(f'{B}@1', step='b'), f'{B}_r1': calling(f'{C}@1', step='c'),
                      f'{C}_r1': two_agents()})
    refused = refusal(calling(f'{A}@1', step='a'), deeper)
    assert refused.node_id == 'a.b.c'
    assert 'calls nest at most 2 deep' in refused.message


def test_a_flow_in_its_own_chain_of_calls_is_a_cycle() -> None:
    assert 'never calls itself' in refusal(calling(f'{ROOT}@1'), Saved(**{f'{ROOT}_r1': two_agents()})).message
    through = Saved(**{f'{A}_r1': calling(f'{ROOT}@2', step='back')})
    refused = refusal(calling(f'{A}@1'), through)
    assert (refused.node_id, 'already in its chain of calls' in refused.message) == ('call.back', True)
    # (A calls B calls A: a cycle by the flow's id, whatever the revision)
    loop = Saved(**{f'{A}_r1': calling(f'{B}@1', step='b'), f'{B}_r1': calling(f'{A}@1', step='a')})
    assert 'never calls itself' in refusal(calling(f'{A}@1'), loop, root=None).message


def test_the_step_cap_counts_every_call_expanded() -> None:
    wide = flow([node('start', 'start'), *(node(f's{n}', 'agent', role='hunter') for n in range(30)),
                 node('done', 'end')],
                [arrow('start', 's0'), *(arrow(f's{n}', f's{n + 1}') for n in range(29)), arrow('s29', 'done')])
    read = Saved(**{f'{A}_r1': wide, f'{B}_r1': wide})
    caller = flow([node('start', 'start'), node('one', 'call_flow', flow=f'{A}@1'),
                   node('two', 'call_flow', flow=f'{B}@1'), node('end', 'end')],
                  [arrow('start', 'one'), arrow('one', 'two'), arrow('two', 'end')])
    refused = refusal(caller, read)
    assert (refused.node_id, f'at most {MAX_NODES}' in refused.message) == ('two', True)
    # (one of them fits: 30 steps and the caller's own)
    assert len(expand(calling_only(f'{A}@1'), read, root=ROOT).definition['nodes']) == 32


def test_the_called_flows_shares_are_scaled_to_the_calls() -> None:
    read = Saved(**{f'{A}_r1': two_agents(0.5, 0.3)})
    caller = calling(f'{A}@1', share=0.4)
    caller['nodes'][2]['data']['params']['budget_share'] = 0.6
    expanded = expand(caller, read, root=ROOT)
    shares = {item['id']: item['data']['params'].get('budget_share') for item in expanded.definition['nodes']}
    assert (shares['call.hunt'], shares['call.fix'], shares['build']) == (0.2, 0.12, 0.6)
    # (a call without a share leaves them as they are; then the run's shares must still fit its budget)
    unscaled = expand(calling(f'{A}@1'), read, root=ROOT).definition
    assert [item['data']['params'].get('budget_share') for item in unscaled['nodes'][1:3]] == [0.5, 0.3]
    over = calling(f'{A}@1')
    over['nodes'][2]['data']['params']['budget_share'] = 0.5
    assert 'budget shares add up to more' in refusal(over, read).message


@pytest.mark.parametrize(('share', 'of', 'scaled'), [
    (0.1, 0.7, 0.07), (0.3, 0.1, 0.03), (1, 0.25, 0.25), (0.333333, 0.5, 0.166666), (0.000001, 0.5, 0.000001),
])
def test_a_scaled_share_is_floored_to_six_places_never_to_zero(share: float, of: float, scaled: float) -> None:
    assert scaled_share(share, of) == scaled


def test_the_expanded_ids_are_the_calls_and_at_most_64_characters() -> None:
    long_step = 'x' * 60
    read = Saved(**{f'{A}_r1': flow([node('start', 'start'), node(long_step, 'agent', role='hunter'),
                                     node('done', 'end')],
                                    [{**arrow('start', long_step), 'id': 'in'}, {**arrow(long_step, 'done'), 'id': 'out'}])})
    refused = refusal(calling_only(f'{A}@1', step='call'), read)
    assert (refused.node_id, 'longer than 64 characters' in refused.message) == ('call', True)
    fits = expand(calling_only(f'{A}@1', step='c'), Saved(**{f'{A}_r1': two_agents()}), root=ROOT)
    assert all(len(step) <= 64 for step in ids(fits.definition))
    assert {edge['id'] for edge in fits.definition['edges']} == {'start-c.hunt', 'c.hunt-c.fix', 'c.fix-end'}


def test_a_call_reads_the_revision_it_pins_never_a_later_one() -> None:
    read = Saved(**{f'{A}_r1': two_agents()})
    read.save(A, 2, flow([node('start', 'start'), node('only', 'agent', role='hunter'), node('done', 'end')],
                         [arrow('start', 'only'), arrow('only', 'done')]))
    assert ids(expand(calling(f'{A}@1'), read, root=ROOT).definition)[1:3] == ['call.hunt', 'call.fix']
    assert read.reads == [(A, 1)]
    assert ids(expand(calling(f'{A}@2'), read, root=ROOT).definition)[1] == 'call.only'
    assert 'not a saved revision' in refusal(calling(f'{A}@3'), read).message


def test_a_called_flow_that_ends_at_a_pull_request_is_its_callers_last_step() -> None:
    read = Saved(**{f'{A}_r1': bug_fix()})
    refused = refusal(calling(f'{A}@1'), read)
    assert (refused.node_id, 'ends at a pull request' in refused.message) == ('call', True)
    last = expand(calling_only(f'{A}@1'), read, root=ROOT).definition
    # (its pull request and its human decision point stay; the caller's end that nothing reaches now goes)
    assert 'call.pr' in ids(last)
    assert 'call.human' in ids(last)
    assert 'end' not in ids(last)
    assert ('call.gate', 'call.pr', 'pass') in arrows(last)
    assert ('call.gate', 'call.human', 'fail') in arrows(last)
    assert validate_definition(last).errors == ()


def test_a_called_flow_with_no_plain_end_is_its_callers_last_step() -> None:
    to_a_person = flow([node('start', 'start'), node('hunt', 'agent', role='hunter'),
                        node('human', 'end', status='needs_human')],
                       [arrow('start', 'hunt'), arrow('hunt', 'human')])
    read = Saved(**{f'{A}_r1': to_a_person})
    assert 'no plain end' in refusal(calling(f'{A}@1'), read).message
    assert ids(expand(calling_only(f'{A}@1'), read, root=ROOT).definition) == ['start', 'call.hunt', 'call.human']


def test_an_agents_workflow_or_a_flow_that_breaks_a_rule_is_never_called() -> None:
    agents = {**two_agents(), 'schema': 'voc-workflow/1'}
    assert 'an agents workflow' in refusal(calling(f'{A}@1'), Saved(**{f'{A}_r1': agents})).message
    broken = two_agents()
    broken['edges'].pop()
    assert 'breaks a rule now' in refusal(calling(f'{A}@1'), Saved(**{f'{A}_r1': broken})).message


def test_a_gates_arrow_into_a_call_keeps_its_label() -> None:
    caller = flow([node('start', 'start'), node('hunt', 'agent', role='hunter'),
                   node('board', 'board', posters=['hunter'], claimers=['fixer']),
                   node('gate', 'quality_gate'), node('ship', 'call_flow', flow=f'{A}@1'), node('end', 'end'),
                   node('human', 'end', status='needs_human')],
                  [arrow('start', 'hunt'), arrow('hunt', 'board'), arrow('board', 'gate'),
                   arrow('gate', 'ship', 'pass'), arrow('gate', 'human', 'fail'), arrow('ship', 'end')])
    shipping = flow([node('start', 'start'), node('commit', 'agent', role='committer'), node('pr', 'stop_at_pr')],
                    [arrow('start', 'commit'), arrow('commit', 'pr')])
    expanded = expand(caller, Saved(**{f'{A}_r1': shipping}), root=ROOT).definition
    assert ('gate', 'ship.commit', 'pass') in arrows(expanded)
    assert ('gate', 'human', 'fail') in arrows(expanded)
    assert 'end' not in ids(expanded)
    assert validate_definition(expanded).errors == ()


def test_a_save_is_refused_for_the_expansions_dot_its_record_and_a_call_it_cannot_expand() -> None:
    read = Saved(**{f'{A}_r1': two_agents()})
    dotted = flow([node('start', 'start'), node('a.b', 'agent', role='hunter'), node('end', 'end')],
                  [arrow('start', 'a.b'), arrow('a.b', 'end')])
    assert save_issues(dotted, read) == [(flow_expand.DOTTED, 'a.b')]
    recorded = bug_fix()
    recorded['nodes'][0]['data']['params'][EXPANSION] = []
    assert save_issues(recorded, read) == [(flow_expand.RECORDED, 'start')]
    assert save_issues(calling(f'{A}@9'), read)[0][1] == 'call'
    assert save_issues(calling(f'{A}@1'), read, root=ROOT) == []
    assert save_issues({**two_agents(), 'schema': 'voc-workflow/1'}, read) == []


def test_a_calls_inputs_name_the_inputs_its_flow_declares() -> None:
    declared = {**two_agents(), 'inputs': {'issue': {'type': 'issue_ref', 'required': True}}}
    read = Saved(**{f'{A}_r1': declared, f'{B}_r1': two_agents()})
    caller = calling(f'{A}@1')
    caller['nodes'][1]['data']['params']['inputs'] = {'issue': "the run's issue"}
    caller['inputs'] = {'issue': {'type': 'issue_ref'}}
    expanded = expand(caller, read, root=ROOT)
    # (the caller's own inputs are the run's; the call's are recorded with it)
    assert expanded.definition['inputs'] == {'issue': {'type': 'issue_ref'}}
    assert expanded.expansion == ({'step': 'call', 'flow': A, 'revision': 1, 'inputs': {'issue': "the run's issue"}},)
    unknown = calling(f'{B}@1')
    unknown['nodes'][1]['data']['params']['inputs'] = {'issue': 'x'}
    refused = refusal(unknown, read)
    assert (refused.node_id, 'does not declare: issue' in refused.message) == ('call', True)


def test_a_runs_copy_answers_the_calls_it_records_and_nothing_off_their_shape() -> None:
    # (7.52.00: the run workspace's overview reads them back from the run's copy, recorded_expansion)
    declared = {**two_agents(), 'inputs': {'issue': {'type': 'issue_ref'}}}
    caller = calling(f'{A}@1')
    caller['nodes'][1]['data']['params']['inputs'] = {'issue': "the run's issue"}
    expanded = expand(caller, Saved(**{f'{A}_r1': declared}), root=ROOT)
    assert flow_expand.recorded_expansion(expanded.definition) == [
        {'step': 'call', 'flow': A, 'revision': 1, 'inputs': {'issue': "the run's issue"}}]
    assert flow_expand.recorded_expansion(bug_fix()) == []
    assert flow_expand.recorded_expansion(None) == []
    broken = copy.deepcopy(expanded.definition)
    broken['nodes'][0]['data']['params'][EXPANSION] = [
        {'step': 'call', 'flow': 'wf_nothex', 'revision': 1}, {'step': 3, 'flow': A, 'revision': 1}, 'call',
        {'step': 'call', 'flow': A, 'revision': True}, {'step': 'call', 'flow': B, 'revision': 2}]
    assert flow_expand.recorded_expansion(broken) == [{'step': 'call', 'flow': B, 'revision': 2}]
