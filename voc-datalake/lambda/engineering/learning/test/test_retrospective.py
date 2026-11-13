"""The retrospective, pure: a fictional ended run's record in, its failures, what goes to the coach, its scorecards
and each failure's evidence (bounded, redacted) out."""
from __future__ import annotations

from dataclasses import replace
from decimal import Decimal
from typing import Any

import pytest

from engineering.board.model import Move, Task
from engineering.coach.failure import MAX_ATTEMPT, MAX_EVIDENCE
from engineering.learning.retrospective import (
    COMMENT_CHARS,
    MAX_COACHED,
    TASK_CHARS,
    AgentRecord,
    GateVerdict,
    HostReaction,
    RunRecord,
    ScoreLine,
    build_retrospective,
    coach_attempt,
    evidence,
    fit,
    no_host_reactions,
    version_label,
)
from engineering.learning.test.fixtures import CONN, RUN, SECRET, WS, moves, tasks

GATE = GateVerdict(task_id='t-gate', attempt=1, verdict='NO-GO', no_go=True, rounds=2,
                   reasons=('The suite was not run on the whole package.',))


def agents() -> tuple[AgentRecord, ...]:
    return (AgentRecord('fixer-2', 'fixer', 'fixer@1', 100, Decimal('0.25')),
            AgentRecord('fixer-3', 'fixer', 'fixer@1', 200, Decimal('0.75')),
            AgentRecord('fixer-4', 'fixer', 'fixer@2', 50, Decimal('0.1')),
            AgentRecord('builder-5', 'builder', '', 30, Decimal('0.05'), crashes=2,
                        last_failure=f'the session stopped answering; key {SECRET}'),
            AgentRecord('builder-6', 'builder', '', 40, Decimal('0.05')),
            AgentRecord('final-go-7', 'final-go', 'final-go@1', 20, Decimal('0.4')),
            AgentRecord('coordinator-1', 'coordinator', 'coordinator@1', 300, Decimal('0.3')))


def record(**changes: Any) -> RunRecord:
    history: dict[str, list[Move]] = {}
    for move in moves():
        history.setdefault(move.task_id, []).append(move)
    base = RunRecord(ws=WS, run_id=RUN, connection=CONN, status='done', started_at='2026-11-13T08:00:00Z',
                     ended_at='2026-11-13T09:00:00Z', tasks=tuple(Task.from_item(item) for item in tasks()),
                     history=history, agents=agents(), gates=(GATE,))
    return replace(base, **changes)


def test_every_failed_attempt_is_listed_most_severe_first() -> None:
    retro = build_retrospective(record())
    assert [failure.key for failure in retro.failures] == [
        't-slug#2#no_go', 't-units#1#failed', 't-feature#1#crashed', 't-slug#1#timed_out']
    assert [failure.kind for failure in retro.failures] == ['no_go', 'error', 'error', 'timeout']
    assert retro.failure_count == 4
    no_go = retro.failures[0]
    assert (no_go.attempt.agent, no_go.attempt.version, no_go.gate) == ('fixer-3', 'fixer@1', GATE)
    # The re-post's reason says how the attempt ended.
    assert (retro.failures[3].attempt.agent, retro.failures[3].attempt.reason) == ('fixer-2', 'stalled')


def test_the_coach_gets_the_first_failure_per_role_and_kind_at_most_three() -> None:
    retro = build_retrospective(record())
    # The fixer's time-out is a fourth: past the bound (and the fixer's no_go and error came first).
    assert [failure.key for failure in retro.to_coach] == ['t-slug#2#no_go', 't-units#1#failed', 't-feature#1#crashed']
    assert len(retro.to_coach) == MAX_COACHED


def test_one_kind_per_role_goes_to_the_coach_and_the_coach_never_coaches_itself() -> None:
    task_items = [replace(task, role='coach') if task.task_id == 't-units' else task
                  for task in (Task.from_item(item) for item in tasks())]
    coach = AgentRecord('fixer-4', 'coach', 'coach@1', 1, Decimal(0))
    retro = build_retrospective(record(tasks=tuple(task_items),
                                       agents=(*agents()[:2], coach, *agents()[3:]), gates=()))
    # t-units is the coach's now; t-feature's crash is the builder's error; the fixer's time-out is its own kind.
    assert [failure.key for failure in retro.to_coach] == ['t-feature#1#crashed', 't-slug#1#timed_out']


def test_scorecards_count_each_version_apart_and_leave_a_persons_work_out() -> None:
    lines = {(line.role, line.version): line for line in build_retrospective(record()).scorecards}
    assert set(lines) == {('fixer', 'fixer@1'), ('fixer', 'fixer@2'), ('builder', 'none'),
                          ('final-go', 'final-go@1'), ('coordinator', 'coordinator@1')}
    assert lines['fixer', 'fixer@1'] == ScoreLine(
        'fixer', 'fixer@1', tasks_done=1, reposts=1, review_rounds=3, attempts=2, cost_usd=Decimal('1.00'),
        seconds=300)
    assert lines['fixer', 'fixer@2'] == ScoreLine('fixer', 'fixer@2', tasks_failed=1, attempts=1,
                                                  cost_usd=Decimal('0.1'), seconds=50)
    assert lines['builder', 'none'] == ScoreLine('builder', 'none', needs_human=1, reposts=1, attempts=2,
                                                 cost_usd=Decimal('0.10'), seconds=70)
    # t-person was a person's: no version counts it.
    assert sum(line.tasks_done for line in lines.values()) == 3


def test_a_no_go_with_no_judged_task_is_counted_apart() -> None:
    lone = replace(GATE, task_id='t-units')   # (a gate verdict on a task with no parent)
    retro = build_retrospective(record(gates=(lone,)))
    assert retro.unattributed_no_go == 1
    assert all(failure.how != 'no_go' for failure in retro.failures)


def test_a_go_is_no_failure_but_its_rounds_still_count() -> None:
    retro = build_retrospective(record(gates=(replace(GATE, verdict='GO', no_go=False),)))
    assert retro.failures[0].key == 't-units#1#failed'
    lines = {(line.role, line.version): line for line in retro.scorecards}
    assert lines['fixer', 'fixer@1'].review_rounds == 3


def test_the_latest_gate_record_of_a_final_go_task_wins() -> None:
    older = replace(GATE, attempt=1, no_go=True)
    newer = replace(GATE, attempt=2, verdict='GO', no_go=False, rounds=1)
    retro = build_retrospective(record(gates=(newer, older)))
    assert all(failure.how != 'no_go' for failure in retro.failures)


def test_an_attempt_nobody_claimed_and_an_unfinished_one() -> None:
    task = Task.from_item(tasks()[2])
    never = replace(task, task_id='t-never', state='open')
    running = replace(task, task_id='t-running', state='in_progress')
    history = dict(record().history)
    history['t-running'] = [replace(move, task_id='t-running') for move in history['t-units'][:1]]
    retro = build_retrospective(record(tasks=(never, running), history=history, gates=()))
    assert retro.failures == ()
    [line] = retro.scorecards[:1]
    assert (line.role, line.attempts, line.tasks_done, line.tasks_failed) == ('builder', 0, 0, 0)


def retro_of_units(history: dict[str, Any], **task: Any) -> Any:
    """The retrospective with t-units' history and task row changed as given."""
    task_items = tuple(replace(item, **task) if item.task_id == 't-units' else item for item in record().tasks)
    return build_retrospective(record(tasks=task_items, history=history))


def test_a_release_by_a_person_is_no_failure() -> None:
    history = dict(record().history)
    history['t-units'] = [*history['t-units'][:1],
                          replace(history['t-slug'][3], task_id='t-units', op='release', reason='released by a person')]
    retro = retro_of_units(history, attempt=2, state='open')
    assert 't-units#1#failed' not in [failure.key for failure in retro.failures]


@pytest.mark.parametrize(('status', 'how'), [('failed', ['crashed']), ('stopped', [])])
def test_a_persons_resume_replacing_a_coordinator_is_a_crash_only_when_its_session_failed(
        status: str, how: list[str]) -> None:
    """Its re-post is the person's (board_bus.coordinator_to_start), never read as a supervisor's time-out."""
    history = dict(record().history)
    claim = history['coordinate'][0]
    history['coordinate'] = [claim, replace(claim, state='open', actor='human:admin-sub-1', attempt=2, op='repost',
                                            reason='coordinator-1 is gone: a new coordinator')]
    task_items = tuple(replace(task, attempt=2, state='open') if task.task_id == 'coordinate' else task
                       for task in record().tasks)
    agents_now = tuple(replace(agent, status=status) if agent.agent == 'coordinator-1' else agent
                       for agent in agents())
    retro = build_retrospective(record(tasks=task_items, history=history, agents=agents_now))
    assert [failure.how for failure in retro.failures if failure.attempt.task.task_id == 'coordinate'] == how


@pytest.mark.parametrize('state', ['done', 'failed'])
def test_a_task_a_person_took_over_is_not_charged_to_the_agent_that_claimed_it(state: str) -> None:
    history = dict(record().history)
    claim = history['t-units'][0]
    person = 'human:admin-sub-1'
    history['t-units'] = [claim, replace(claim, state='claimed', actor=person, op='take', at='2026-11-13T08:40:00Z'),
                          replace(claim, state=state, actor=person, op='move', at='2026-11-13T08:41:00Z')]
    retro = retro_of_units(history, state=state)
    assert 't-units#1#failed' not in [failure.key for failure in retro.failures]
    lines = {(line.role, line.version): line for line in retro.scorecards}
    line = lines['fixer', 'fixer@2']
    assert (line.attempts, line.tasks_done, line.tasks_failed, line.reposts) == (1, 0, 0, 0)


def test_a_no_go_on_a_persons_take_over_is_not_the_agents() -> None:
    history = dict(record().history)
    claim = history['t-slug'][4]   # fixer-3's claim of attempt 2
    history['t-slug'] = [*history['t-slug'][:5],
                         replace(claim, actor='human:admin-sub-1', op='take', at='2026-11-13T08:40:00Z')]
    retro = build_retrospective(record(history=history))
    assert all(failure.how != 'no_go' for failure in retro.failures)


def test_version_labels() -> None:
    assert [version_label(raw) for raw in ('fixer@3', '', 'Fixer v3!')] == ['fixer@3', 'none', 'unlabelled']


def test_the_evidence_is_the_attempts_own_record_bounded_and_redacted() -> None:
    retro = build_retrospective(record())
    crashed = next(failure for failure in retro.failures if failure.how == 'crashed')
    found = evidence(crashed, retro.run)
    assert found.task.startswith('Build the duration field\n\n{"goal"')
    text = '\n'.join(found.outputs)
    assert 'Attempt 1 of the builder task ended crashed (crashed); held by builder-5.' in text
    assert 'claimed by builder-5 via claim' in text
    assert 'The supervisor recorded (2 crash(es)): the session stopped answering' in text
    assert SECRET not in text
    assert '<redacted>' in text
    no_go = evidence(retro.failures[0], retro.run)
    assert 'Quality gate: NO-GO, 2 round(s).\nThe suite was not run on the whole package.' in no_go.outputs
    assert found.comments == ()


def test_host_reactions_are_an_empty_port_today_and_become_comments_when_they_come() -> None:
    assert no_host_reactions(record()) == ()
    reactions = (HostReaction('t-units', 'comment', 'Please keep the parser change small. ' * 60),
                 HostReaction('t-slug', 'revert', 'Reverted: it broke the release.'))
    retro = build_retrospective(record(), lambda _run: reactions)
    failed = next(failure for failure in retro.failures if failure.how == 'failed')
    [comment] = evidence(failed, retro.run, retro.reactions).comments
    assert comment.startswith('comment: Please keep')
    assert len(comment) <= COMMENT_CHARS


def test_a_huge_task_is_cut_to_fit_and_the_evidence_stays_inside_the_coachs_bound() -> None:
    task_items = tuple(replace(task, title='T' * 9_000) if task.task_id == 't-units' else task
                       for task in record().tasks)
    retro = build_retrospective(record(tasks=task_items))
    failed = next(failure for failure in retro.failures if failure.how == 'failed')
    found = evidence(failed, retro.run)
    assert len(found.task) == TASK_CHARS
    assert found.task.endswith('[cut]')
    assert sum(map(len, (found.task, *found.outputs, *found.comments))) <= MAX_EVIDENCE


@pytest.mark.parametrize(('text', 'limit', 'expected'), [
    ('short', 10, 'short'), ('a\x00b', 10, 'ab'), ('x' * 20, 10, 'xxxx [cut]')])
def test_fit(text: str, limit: int, expected: str) -> None:
    assert fit(text, limit) == expected


def test_the_coachs_attempt_is_bounded() -> None:
    assert (coach_attempt(2), coach_attempt(MAX_ATTEMPT + 5)) == (2, MAX_ATTEMPT)
