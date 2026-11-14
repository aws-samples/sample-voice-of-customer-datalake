"""The conductor: every default flow driven from its start to its end, step by step, and the edge cases of the rules
(the joins, a gate's two ways, a person's decisions, the steps not run yet, what the board may take at each step)."""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from typing import Any

import pytest

from engineering.board.model import DONE as BOARD_DONE
from engineering.board.model import FINAL as BOARD_FINAL
from engineering.flow.conductor import (
    AT_A_PERSON,
    BLOCKED,
    COLLECTING,
    COMPLETE,
    DONE,
    FINISHED,
    GATE_ROLES,
    GOING,
    HALTED,
    HUMAN,
    LIVE,
    NOT_YET_RUN,
    PASSED,
    READY,
    RUNNING,
    SKIPPED,
    STOPPED,
    TASK_DONE,
    TASK_ENDED,
    WAITING,
    BoardState,
    Flow,
    FlowError,
    Plan,
    StepTask,
    conduct,
)
from engineering.flow.ledger import FINAL_GO_ROLE
from engineering.flow.test.fixtures import TEMPLATES
from shared.workflow_schema import validate_definition

STATUSES = frozenset({WAITING, READY, RUNNING, COLLECTING, DONE, NOT_YET_RUN, PASSED, BLOCKED, STOPPED, HUMAN,
                      SKIPPED})


def test_the_task_states_are_the_boards():
    assert (TASK_DONE, TASK_ENDED) == (BOARD_DONE, BOARD_FINAL)


def test_the_six_default_flows_are_all_here_and_valid():
    assert sorted(TEMPLATES) == ['bug-hunt-and-fix', 'feature', 'issue-triage', 'pr-review', 'self-improvement',
                                 'understand-repository']
    assert all(validate_definition(definition).valid for definition in TEMPLATES.values())


# --- the invariants every plan keeps --------------------------------------------------------------------------

def _invariants(flow: Flow, plan: Plan) -> None:
    """Every step has a known status; a step past its turn has every way in finished (a collecting board excepted),
    one waiting has one that has not; the outcome says what the steps say."""
    assert list(plan.steps) == list(flow.order)
    for step_id, state in plan.steps.items():
        assert state.status in STATUSES
        before = [plan.steps[arrow.source].status for arrow in flow.into(step_id)]
        if flow.steps[step_id].type == 'start':
            assert state.status == DONE
        elif state.status == WAITING:
            assert any(status not in COMPLETE | {SKIPPED} for status in before)
        elif state.status == COLLECTING:
            assert flow.steps[step_id].type == 'board'
        else:
            assert all(status in COMPLETE | {SKIPPED} for status in before), (step_id, before)
        if state.status in LIVE:
            # (no roles: a map or a coordinator's step, a step after a map with every shard under way, a gate whose
            # verdict is not read yet)
            assert state.roles or flow.steps[step_id].type in {'map', 'agent', 'quality_gate'}
    halted = [state for state in plan.steps.values() if state.status in HALTED]
    if halted:
        assert (plan.outcome, plan.at, plan.decision_point) == (AT_A_PERSON, halted[0].step, f'flow:{halted[0].step}')
    elif plan.live():
        assert (plan.outcome, plan.at, plan.decision_point) == (GOING, '', '')
    elif plan.outcome == FINISHED:
        assert flow.steps[plan.at].type in {'end', 'stop_at_pr'}
    else:   # (nothing live and no end reached)
        assert (plan.outcome, plan.at) == (AT_A_PERSON, '')


# --- a driver: the board's agents and a person doing what each live step asks -----------------------------------

class Run:
    """A run of a flow, done the canonical way: every task posted ends as ``outcome`` says (done by default)."""

    def __init__(self, definition: Mapping[str, Any], *, failing: frozenset[str] = frozenset(), verdict: str = 'go',
                 shards: tuple[str, ...] = ('core', 'web')) -> None:
        self.flow = Flow.from_definition(definition)
        self.tasks: list[StepTask] = []
        self.fanned: dict[str, tuple[str, ...]] = {}
        self.completed: set[str] = set()
        self.decisions: Counter[str] = Counter()
        self.failing = set(failing)
        self.verdict = verdict
        self.verdicts: dict[str, str] = {}
        self.shards = shards
        self.log: list[tuple[str, ...]] = []

    def plan(self) -> Plan:
        plan = conduct(self.flow, BoardState(tuple(self.tasks), dict(self.fanned), frozenset(self.completed),
                                             dict(self.decisions), verdicts=dict(self.verdicts)))
        _invariants(self.flow, plan)
        return plan

    def _task(self, step: str, role: str, shard: str = '', *, state: str = TASK_DONE) -> None:
        if step in self.failing:   # (each failing step fails once, then is done)
            self.failing.discard(step)
            state = 'failed'
        at = f'2026-11-14T10:{len(self.tasks):02d}:00+00:00'
        self.tasks.append(StepTask(f'task-{len(self.tasks) + 1}', step, role, state, shard, at))
        self.log.append(('task', step, role, *((shard,) if shard else ()), *(() if state == TASK_DONE else (state,))))

    def act(self, plan: Plan) -> None:
        state = plan.live()[0]
        step = self.flow.steps[state.step]
        own = step.type == 'agent' and step.params.get('role') == 'coordinator'
        drained = step.type == 'board' and any(task.step == step.id for task in self.tasks)
        if step.type == 'map':
            self.fanned[step.id] = self.shards
            self.log.append(('fan_out', step.id))
        elif own or drained:
            self.completed.add(step.id)
            self.log.append(('complete', step.id))
        elif step.type in {'agent', 'board'}:
            self._task(step.id, state.roles[0], *state.shards_left[:1])
        elif step.type == 'quality_gate':
            if FINAL_GO_ROLE not in state.roles:   # (offered only once a gate runner's task is done)
                self._task(step.id, 'gate-runner')
            else:
                # The final go ends done either way: its gate record's verdict is the GO ledger's to read.
                self._task(step.id, FINAL_GO_ROLE)
                self.verdicts[step.id] = self.verdict
        else:   # pragma: no cover - (every live kind is above)
            raise AssertionError(step.type)

    def drive(self, limit: int = 60) -> list[tuple[str, ...]]:
        for _ in range(limit):
            plan = self.plan()
            if plan.outcome == FINISHED:
                self.log.append(('finished', plan.at))
                return self.log
            if plan.outcome == AT_A_PERSON:
                self.log.append(('person', plan.at))
                self.decisions[plan.at] += 1
                continue
            self.act(plan)
        raise AssertionError(f'the flow never finished: {self.log}')


def test_understand_the_repository_maps_each_package_reduces_drafts_and_waits_for_an_administrator():
    run = Run(TEMPLATES['understand-repository'])
    first = run.plan()
    assert ([s.step for s in first.live()], first.steps['map'].status, first.steps['mapper'].status) == (
        ['map'], READY, WAITING)
    assert run.drive() == [
        ('fan_out', 'map'), ('task', 'mapper', 'mapper', 'core'), ('task', 'mapper', 'mapper', 'web'),
        ('task', 'understander', 'understander'),
        ('person', 'approval'), ('finished', 'approval')]
    plan = run.plan()
    assert (plan.steps['memory'].status, plan.steps['reduce'].status, plan.steps['approval'].status) == (
        NOT_YET_RUN, DONE, PASSED)
    assert [state.step for state in plan.not_yet_run()] == ['memory']


def test_issue_triage_recalls_nothing_yet_and_runs_its_three_agents_in_order():
    run = Run(TEMPLATES['issue-triage'])
    assert run.drive() == [('task', 'classify', 'understander'), ('task', 'locate', 'hunter'),
                           ('task', 'propose', 'understander'), ('finished', 'end')]
    assert run.plan().steps['memory'].status == NOT_YET_RUN


def test_bug_hunt_and_fix_takes_the_hunters_posts_while_it_hunts_and_stops_at_the_draft_pr_on_a_go():
    run = Run(TEMPLATES['bug-hunt-and-fix'])
    first = run.plan()
    # The board collects the hunter's posts while it hunts: the hunt, then the board, both live.
    assert [(s.step, s.status) for s in first.live()] == [('hunt', READY), ('board', COLLECTING)]
    assert first.steps['board'].roles == ('understander', 'fixer', 'commit-reviewer')
    # The commit comes after the gate's GO (the broker pushes only a GO'd tree), then the draft pull request.
    assert run.drive() == [
        ('task', 'hunt', 'hunter'), ('task', 'board', 'understander'), ('complete', 'board'),
        ('task', 'gate', 'gate-runner'), ('task', 'gate', 'final-go'), ('task', 'commit', 'committer'),
        ('task', 'pr_author', 'pr-author'), ('finished', 'pr')]
    plan = run.plan()
    assert (plan.steps['gate'].verdict, plan.steps['human'].status, plan.steps['pr'].status) == ('go', SKIPPED, DONE)


def test_a_no_go_takes_the_gates_fail_arrow_to_a_person_and_never_to_the_pull_request():
    """A final go that ended done with a NO-GO record (the GO ledger's verdict) routes to ``fail``."""
    run = Run(TEMPLATES['bug-hunt-and-fix'], verdict='no_go')
    assert run.drive()[-4:] == [('task', 'gate', 'gate-runner'), ('task', 'gate', 'final-go'),
                                ('person', 'human'), ('finished', 'human')]
    assert [task.state for task in run.tasks if task.role == 'final-go'] == ['done']
    plan = run.plan()
    assert (plan.steps['gate'].verdict, plan.steps['commit'].status, plan.steps['pr_author'].status,
            plan.steps['pr'].status) == ('no_go', SKIPPED, SKIPPED, SKIPPED)


def test_the_feature_flow_has_the_coordinator_plan_itself_then_post_the_builders_work():
    run = Run(TEMPLATES['feature'])
    assert run.drive() == [
        ('task', 'understand', 'understander'), ('complete', 'plan'), ('task', 'board', 'builder'),
        ('complete', 'board'), ('task', 'gate', 'gate-runner'), ('task', 'gate', 'final-go'),
        ('task', 'commit', 'committer'), ('task', 'pr_author', 'pr-author'), ('finished', 'pr')]


def test_the_feature_board_collects_the_coordinators_posts_while_it_plans():
    run = Run(TEMPLATES['feature'])
    run.tasks.append(StepTask('task-1', 'understand', 'understander', TASK_DONE))
    plan = run.plan()
    assert [(s.step, s.status, s.roles) for s in plan.live()] == [
        ('plan', READY, ()), ('board', COLLECTING, ('builder', 'commit-reviewer'))]


def test_pr_review_stops_at_its_map_with_no_shard_source_and_goes_on_only_past_a_persons_decision():
    run = Run(TEMPLATES['pr-review'])
    plan = run.plan()
    assert (plan.outcome, plan.at, plan.steps['map'].status) == (AT_A_PERSON, 'map', STOPPED)
    assert 'no shard source for pr_pages' in plan.reason
    assert run.drive() == [('person', 'map'), ('task', 'comment', 'pr-reviewer'), ('finished', 'end')]
    after = run.plan()
    assert (after.steps['map'].status, after.steps['review'].status, after.steps['reduce'].status) == (
        PASSED, NOT_YET_RUN, DONE)


def test_self_improvement_is_not_run_by_a_flow_yet_and_waits_for_a_person_twice():
    run = Run(TEMPLATES['self-improvement'])
    plan = run.plan()
    assert (plan.at, plan.steps['coach'].status, plan.steps['memory'].status) == ('coach', STOPPED, NOT_YET_RUN)
    assert run.drive() == [('person', 'coach'), ('person', 'acceptance'), ('finished', 'acceptance')]


@pytest.mark.parametrize('template', sorted(TEMPLATES))
def test_every_default_flow_finishes_with_each_task_failing_once_and_a_person_deciding(template: str):
    """Each step that takes tasks fails once: the run waits at that step for a person, whose decision gives it one
    more try, and the flow still reaches its end."""
    flow = Flow.from_definition(TEMPLATES[template])
    failing = frozenset(step for step, item in flow.steps.items() if item.type in {'agent', 'board'}
                        and item.params.get('role') != 'coordinator')
    run = Run(TEMPLATES[template], failing=failing)
    log = run.drive(limit=120)
    assert log[-1][0] == 'finished'
    final = run.plan()
    for step in failing - {s for s in flow.steps if final.steps[s].status in {SKIPPED, NOT_YET_RUN}}:
        failed = log.index(next(entry for entry in log if entry[:2] == ('task', step) and entry[-1] == 'failed'))
        assert log[failed + 1] == ('person', step)


# --- edge cases -------------------------------------------------------------------------------------------------

def _definition(nodes: list[tuple[str, str, dict[str, Any]]], edges: list[tuple[str, str] | tuple[str, str, str]],
                **extra: Any) -> dict[str, Any]:
    return {'schema': 'voc-workflow/2', 'name': 'Edge', 'loops': [], **extra,
            'nodes': [{'id': node, 'type': kind, 'position': {'x': 0, 'y': 0}, 'data': {'title': node.title(),
                                                                                     'params': params}}
                      for node, kind, params in nodes],
            'edges': [{'id': f'e{n}', 'source': edge[0], 'target': edge[1], **({'label': edge[2]} if len(edge) > 2
                                                                              else {})}
                      for n, edge in enumerate(edges)]}


def _kind(refusal: tuple[str, str] | None) -> str | None:
    """A refusal's kind (None: no refusal)."""
    return None if refusal is None else refusal[0]


def _plan(definition: dict[str, Any], **board: Any) -> Plan:
    flow = Flow.from_definition(definition)
    plan = conduct(flow, BoardState(**board))
    _invariants(flow, plan)
    return plan


START, END = ('start', 'start', {}), ('end', 'end', {'status': 'completed'})
JOIN = _definition([START, ('a', 'agent', {'role': 'hunter'}), ('b', 'agent', {'role': 'understander'}),
                    ('j', 'agent', {'role': 'fixer'}), END],
                   [('start', 'a'), ('start', 'b'), ('a', 'j'), ('b', 'j'), ('j', 'end')])


def test_two_ways_run_together_and_their_join_waits_for_both():
    plan = _plan(JOIN)
    assert [s.step for s in plan.live()] == ['a', 'b']
    plan = _plan(JOIN, tasks=(StepTask('t1', 'a', 'hunter', TASK_DONE),))
    assert (plan.steps['j'].status, [s.step for s in plan.live()]) == (WAITING, ['b'])
    plan = _plan(JOIN, tasks=(StepTask('t1', 'a', 'hunter', TASK_DONE), StepTask('t2', 'b', 'understander', 'done')))
    assert plan.steps['j'].status == READY


def test_an_end_reached_on_one_way_waits_for_the_others_before_the_flow_finishes():
    definition = _definition([START, ('a', 'agent', {'role': 'hunter'}), END, ('b', 'agent', {'role': 'fixer'}),
                              ('end2', 'end', {'status': 'completed'})],
                             [('start', 'a'), ('a', 'end'), ('start', 'b'), ('b', 'end2')])
    plan = _plan(definition, tasks=(StepTask('t1', 'a', 'hunter', TASK_DONE),))
    assert (plan.outcome, plan.steps['end'].status) == (GOING, DONE)
    plan = _plan(definition, tasks=(StepTask('t1', 'a', 'hunter', TASK_DONE), StepTask('t2', 'b', 'fixer', 'done')))
    assert (plan.outcome, plan.at) == (FINISHED, 'end')


def test_a_blocked_step_waits_for_a_person_and_each_decision_is_one_more_try():
    failed = (StepTask('t1', 'a', 'hunter', 'failed'),)
    plan = _plan(JOIN, tasks=failed)
    assert (plan.outcome, plan.at, plan.steps['a'].status, plan.steps['b'].status) == (AT_A_PERSON, 'a', BLOCKED, READY)
    assert _plan(JOIN, tasks=failed, decisions={'a': 1}).steps['a'].status == READY
    twice = (*failed, StepTask('t2', 'a', 'hunter', 'needs_human'))
    assert _plan(JOIN, tasks=twice, decisions={'a': 1}).steps['a'].status == BLOCKED
    assert _plan(JOIN, tasks=twice, decisions={'a': -3}).steps['a'].status == BLOCKED   # (never fewer than none)


def test_an_agent_step_takes_one_task_at_a_time_and_is_done_with_one_done():
    running = _plan(JOIN, tasks=(StepTask('t1', 'a', 'hunter', 'in_progress'),))
    assert (running.steps['a'].status, running.post_refusal('a', 'hunter', poster='coordinator')) == (
        RUNNING, ('conflict', 'step a has its task under way'))
    after_failure = _plan(JOIN, tasks=(StepTask('t1', 'a', 'hunter', 'failed'), StepTask('t2', 'a', 'hunter', 'done')))
    assert after_failure.steps['a'].status == DONE


MAPPED = _definition([START, ('map', 'map', {'shard_by': 'packages', 'shard_cap': 2}),
                      ('m', 'agent', {'role': 'mapper'}), ('r', 'reduce', {}), END],
                     [('start', 'map'), ('map', 'm'), ('m', 'r'), ('r', 'end')])


def test_a_step_after_a_map_takes_one_task_per_shard_and_its_reduce_waits_for_all_of_them():
    fanned = {'map': ('core', 'web')}
    plan = _plan(MAPPED, fanned_out=fanned, tasks=(StepTask('t1', 'm', 'mapper', 'claimed', 'core'),))
    assert (plan.steps['m'].status, plan.steps['m'].shards_left, plan.steps['r'].status) == (RUNNING, ('web',), WAITING)
    assert plan.post_refusal('m', 'mapper', poster='coordinator', shard='web') is None
    assert _kind(plan.post_refusal('m', 'mapper', poster='coordinator', shard='core')) == 'conflict'
    assert _kind(plan.post_refusal('m', 'mapper', poster='coordinator')) == 'conflict'
    busy = _plan(MAPPED, fanned_out=fanned, tasks=(StepTask('t1', 'm', 'mapper', 'claimed', 'core'),
                                                   StepTask('t2', 'm', 'mapper', 'open', 'web')))
    assert (busy.steps['m'].status, busy.steps['m'].roles) == (RUNNING, ())
    blocked = _plan(MAPPED, fanned_out=fanned, tasks=(StepTask('t1', 'm', 'mapper', 'failed', 'core'),))
    assert (blocked.at, 'core' in blocked.reason) == ('m', True)
    done = _plan(MAPPED, fanned_out=fanned, tasks=(StepTask('t1', 'm', 'mapper', 'done', 'core'),
                                                   StepTask('t2', 'm', 'mapper', 'done', 'web')))
    assert (done.steps['m'].status, done.steps['r'].status, done.outcome) == (DONE, DONE, FINISHED)


def test_a_maps_shards_are_listed_once_within_its_cap():
    plan = _plan(MAPPED)
    assert plan.fan_out_refusal('map', ['core', 'web']) is None
    assert 'takes 1 to 2 shards' in str(plan.fan_out_refusal('map', ['a', 'b', 'c']))
    assert 'each once' in str(plan.fan_out_refusal('map', ['a', 'a']))
    assert 'takes 1 to 2' in str(plan.fan_out_refusal('map', []))
    assert 'not a map step' in str(plan.fan_out_refusal('m', ['a']))
    assert 'listed once' in str(_plan(MAPPED, fanned_out={'map': ('a',)}).fan_out_refusal('map', ['b']))


BOARD = _definition([START, ('hunt', 'agent', {'role': 'hunter'}),
                     ('board', 'board', {'posters': ['hunter'], 'claimers': ['fixer'], 'until': 'drained'}), END],
                    [('start', 'hunt'), ('hunt', 'board'), ('board', 'end')])


def test_who_may_post_on_a_board_and_on_an_agent_step():
    plan = _plan(BOARD)
    assert plan.post_refusal('board', 'fixer', poster='hunter') is None
    assert plan.post_refusal('board', 'fixer', poster='coordinator') is None
    assert _kind(plan.post_refusal('board', 'fixer', poster='builder')) == 'forbidden'
    assert _kind(plan.post_refusal('hunt', 'hunter', poster='hunter')) == 'forbidden'
    assert _kind(plan.post_refusal('board', 'builder', poster='coordinator')) == 'forbidden'
    assert _kind(plan.post_refusal('hunt', 'hunter', poster='coordinator', shard='core')) == 'invalid'
    assert _kind(plan.post_refusal('nope', 'hunter', poster='coordinator')) == 'invalid'
    assert _kind(plan.post_refusal('end', 'hunter', poster='coordinator')) == 'conflict'


def test_a_board_waits_for_its_posters_once_they_stop_and_closes_only_with_nothing_under_way():
    waiting = _plan(BOARD, tasks=(StepTask('t1', 'hunt', 'hunter', 'failed'),))
    assert (waiting.steps['board'].status, waiting.at) == (WAITING, 'hunt')
    hunted = (StepTask('t1', 'hunt', 'hunter', TASK_DONE),)
    live = _plan(BOARD, tasks=(*hunted, StepTask('t2', 'board', 'fixer', 'in_review')))
    assert (live.steps['board'].status, 'nothing on it' in str(live.complete_refusal('board'))) == (RUNNING, True)
    ready = _plan(BOARD, tasks=hunted)
    assert (ready.complete_refusal('board'), ready.complete_refusal('hunt') is not None) == (None, True)
    blocked = _plan(BOARD, tasks=(*hunted, StepTask('t2', 'board', 'fixer', 'failed')))
    assert (blocked.steps['board'].status, blocked.at) == (BLOCKED, 'board')
    closed = _plan(BOARD, tasks=hunted, completed=frozenset({'board'}))
    assert (closed.steps['board'].status, closed.outcome) == (DONE, FINISHED)


def test_a_board_until_its_caps_closes_only_at_the_runs_task_cap():
    capped = _definition([START, ('board', 'board', {'posters': ['coordinator'], 'claimers': ['fixer'],
                                                      'until': 'caps'}), END],
                         [('start', 'board'), ('board', 'end')])
    assert 'task cap' in str(_plan(capped).complete_refusal('board'))
    worked = (StepTask('t1', 'board', 'fixer', TASK_DONE),)
    assert _plan(capped, cap_reached=True, tasks=worked).complete_refusal('board') is None


def test_an_empty_board_closes_only_when_an_agent_other_than_the_coordinator_was_to_post_on_it():
    own = _definition([START, ('board', 'board', {'posters': ['coordinator'], 'claimers': ['builder']}), END],
                      [('start', 'board'), ('board', 'end')])
    assert 'post its work before you close it' in str(_plan(own).complete_refusal('board'))
    assert _plan(own, tasks=(StepTask('t1', 'board', 'builder', TASK_DONE),)).complete_refusal('board') is None
    # The hunter found nothing to fix: its board closes empty.
    assert _plan(BOARD, tasks=(StepTask('t1', 'hunt', 'hunter', TASK_DONE),)).complete_refusal('board') is None


GATE = _definition([START, ('gate', 'quality_gate', {}), ('pr', 'stop_at_pr', {}),
                    ('human', 'end', {'status': 'needs_human'})],
                   [('start', 'gate'), ('gate', 'pr', 'pass'), ('gate', 'human', 'fail')])
GATED = StepTask('t0', 'gate', 'gate-runner', TASK_DONE)


def test_a_gate_takes_its_final_go_only_after_a_gate_runners_task_is_done():
    ready = _plan(GATE)
    assert (ready.steps['gate'].status, 'final-go' in ready.steps['gate'].roles) == (READY, False)
    assert _kind(ready.post_refusal('gate', 'final-go', poster='coordinator')) == 'forbidden'
    running = _plan(GATE, tasks=(StepTask('t1', 'gate', 'gate-runner', 'claimed'),))
    assert (running.steps['gate'].status, 'final-go' in running.steps['gate'].roles) == (RUNNING, False)
    assert _plan(GATE, tasks=(StepTask('t1', 'gate', 'gate-runner', 'failed'),)).steps['gate'].status == BLOCKED
    gated = _plan(GATE, tasks=(GATED,))
    assert (gated.steps['gate'].roles, gated.post_refusal('gate', 'final-go', poster='coordinator')) == (
        GATE_ROLES, None)


@pytest.mark.parametrize(('verdict', 'gate', 'at', 'pr'), [
    ('go', DONE, 'pr', DONE), ('no_go', DONE, 'human', SKIPPED), (None, RUNNING, '', WAITING)],
    ids=['go-takes-pass', 'a-no-go-record-takes-fail', 'unread-is-never-a-go'])
def test_a_gate_routes_by_the_go_ledgers_verdict_never_by_the_final_gos_state(
        verdict: str | None, gate: str, at: str, pr: str):
    """A final go that ended done is a GO only when the GO ledger read a GO record: a NO-GO record takes ``fail``,
    and a verdict not read (a reader without the records) waits."""
    tasks = (GATED, StepTask('t1', 'gate', 'final-go', TASK_DONE))
    plan = _plan(GATE, tasks=tasks, verdicts={'gate': verdict} if verdict else {})
    assert (plan.steps['gate'].status, plan.at or ('pr' if plan.outcome == FINISHED else ''), plan.steps['pr'].status) \
        == (gate, at, pr)
    if verdict == 'no_go':
        assert (plan.outcome, plan.steps['gate'].verdict) == (AT_A_PERSON, 'no_go')


def test_a_coordinators_own_step_is_done_only_when_it_records_it():
    own = _definition([START, ('plan', 'agent', {'role': 'coordinator'}), END], [('start', 'plan'), ('plan', 'end')])
    plan = _plan(own)
    assert (plan.steps['plan'].status, plan.steps['plan'].roles, plan.complete_refusal('plan')) == (READY, (), None)
    assert _kind(plan.post_refusal('plan', 'fixer', poster='coordinator')) == 'forbidden'
    assert 'not ready' in str(_plan(own, completed=frozenset({'plan'})).complete_refusal('plan'))
    assert 'no step' in str(plan.complete_refusal('nope'))


def test_a_learning_loop_and_a_memory_step_are_not_run_yet_and_the_flow_goes_on():
    definition = _definition([START, ('recall', 'memory', {'mode': 'read', 'scope': 'repo'}),
                              ('learn', 'learning_loop', {}), END],
                             [('start', 'recall'), ('recall', 'learn'), ('learn', 'end')])
    plan = _plan(definition)
    assert ([s.step for s in plan.not_yet_run()], plan.outcome) == (['recall', 'learn'], FINISHED)
    assert 'retrospective' in plan.steps['learn'].reason


def test_a_step_of_a_kind_the_runtime_does_not_run_stops_at_a_person():
    definition = _definition([START, ('x', 'teleport', {}), END], [('start', 'x'), ('x', 'end')])
    plan = _plan(definition)
    assert (plan.at, plan.steps['x'].status, 'does not run teleport' in plan.reason) == ('x', STOPPED, True)
    assert _plan(definition, decisions={'x': 1}).steps['x'].status == PASSED


def test_launches_are_for_live_steps_only():
    plan = _plan(JOIN)
    assert (plan.launch_refusal('a'), 'is waiting' in str(plan.launch_refusal('j'))) == (None, True)
    assert 'no step' in str(plan.launch_refusal('nope'))


def test_a_flow_with_nothing_live_and_no_end_reached_waits_for_a_person():
    plan = _plan(_definition([START], []))
    assert (plan.outcome, plan.at, plan.decision_point) == (AT_A_PERSON, '', 'flow:')
    assert 'cannot go on' in plan.reason


def test_the_view_gives_the_live_steps_their_settings_and_what_to_do():
    definition = TEMPLATES['understand-repository']
    view = _plan(definition, fanned_out={'map': ('core',)}).view()
    by_step = {item['step']: item for item in view['steps']}
    assert (view['outcome'], view['at'], view['reason']) == (GOING, None, None)
    assert by_step['mapper']['shards_left'] == ['core']
    assert by_step['mapper']['settings'] == {'role': 'mapper'}
    assert 'one task per shard' in by_step['mapper']['next']
    assert 'settings' not in by_step['understander']
    gone = (StepTask('t1', 'hunt', 'hunter', 'done'), GATED, StepTask('t2', 'gate', 'final-go', 'done'))
    gate_view = _plan(TEMPLATES['bug-hunt-and-fix'], tasks=gone, completed=frozenset({'board'}),
                      verdicts={'gate': 'go'}).view()
    by_gate = {item['step']: item for item in gate_view['steps']}
    assert (by_gate['gate']['verdict'], 'reason' in by_gate['gate']) == ('go', False)
    assert by_gate['commit']['instructions']
    feature = {item['step']: item for item in _plan(TEMPLATES['feature']).view()['steps']}
    assert 'instructions' not in feature['understand']
    own = _plan(TEMPLATES['feature'], tasks=(StepTask('t', 'understand', 'understander', 'done'),)).view()
    assert 'do this step yourself' in {item['step']: item for item in own['steps']}['plan']['next']
    lit = _plan(TEMPLATES['issue-triage']).lit()
    assert (lit['memory'], lit['classify'], lit['end']) == (NOT_YET_RUN, READY, WAITING)


@pytest.mark.parametrize(('definition', 'message'), [
    ({'schema': 'voc-workflow/1', 'nodes': [], 'edges': []}, 'engineering flow'),
    ({'schema': 'voc-workflow/2', 'nodes': {}, 'edges': []}, 'steps and its arrows'),
    ({'schema': 'voc-workflow/2', 'nodes': [{'id': 'a'}], 'edges': []}, 'own id'),
    ({'schema': 'voc-workflow/2', 'nodes': [{'id': 'a', 'data': {}}, {'id': 'a', 'data': {}}], 'edges': []},
     'own id'),
    ({'schema': 'voc-workflow/2', 'nodes': [{'id': 'a', 'type': 'start', 'data': {}}],
      'edges': [{'source': 'a', 'target': 'b'}]}, 'joins two steps'),
    ({'schema': 'voc-workflow/2', 'nodes': [{'id': 'a', 'type': 'start', 'data': {}}], 'edges': ['a']},
     'joins two steps'),
    (_definition([START, ('a', 'agent', {'role': 'hunter'}), ('b', 'agent', {'role': 'fixer'})],
                 [('start', 'a'), ('a', 'b'), ('b', 'a')]), 'cycle'),
], ids=['v1', 'nodes-not-a-list', 'no-data', 'same-id', 'arrow-to-nowhere', 'arrow-not-an-object', 'cycle'])
def test_a_definition_the_conductor_cannot_follow_is_refused(definition: dict[str, Any], message: str):
    with pytest.raises(FlowError, match=message):
        Flow.from_definition(definition)


def test_a_steps_odd_params_and_texts_read_as_empty():
    definition = _definition([START, END], [('start', 'end')])
    definition['nodes'][0]['data'] = {'title': 7, 'params': 'none', 'instructions': None}
    flow = Flow.from_definition(definition)
    assert (flow.steps['start'].title, flow.steps['start'].params, flow.steps['start'].instructions) == ('', {}, '')


def test_a_map_inside_another_maps_way_belongs_to_the_nearer_one():
    nested = _definition([START, ('outer', 'map', {'shard_by': 'packages'}), ('inner', 'map', {'shard_by': 'packages'}),
                          ('m', 'agent', {'role': 'mapper'}), ('r', 'reduce', {}), END],
                         [('start', 'outer'), ('outer', 'inner'), ('inner', 'm'), ('m', 'r'), ('r', 'end')])
    flow = Flow.from_definition(nested)
    assert (flow.region['inner'], flow.region['m']) == ('outer', 'inner')
