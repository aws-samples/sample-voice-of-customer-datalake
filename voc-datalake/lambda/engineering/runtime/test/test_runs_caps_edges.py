"""The run caps and the run control's edges (runtime/runs.py): a cap's bounds and refusals in their own words, the
hard cap's, what the supervisor's control answers (the caps it reads, whether the run is active, when a coordinator is
awaited), the budget alerts' claims and flag, and the flow plan (its cached copy of the flow, the task cap, the gate
verdicts it reads and keeps only at a decision point, create-only)."""
from __future__ import annotations

import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest

from engineering.board.model import Task
from engineering.connectors.test.test_records import gate_record
from engineering.flow.conductor import GO, NO_GO, UNREAD, Flow, Plan
from engineering.flow.record import FLOW_SK
from engineering.flow.test.fixtures import TEMPLATES
from engineering.quality_gate.record import GateRecord
from engineering.runtime import runs as runs_module
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.runs import RunCaps, RunNotActive, RunStore, TableRunControl, hard_capped
from engineering.runtime.test.conftest import RUN
from engineering.runtime.test.test_engineering_run_flow import UNDERSTAND, _no_go_at_the_gate, _rows
from engineering.runtime.test.test_engineering_runs import META, NOV, OTHER, _spend, _two_runs_of_one_flow

PK = META['pk']
THIRD = '01JD3R4NZXQ7Y2W8K4M6P9T0EF'
COMMIT = 'c' * 40
FINAL_GO_KEY = f'ws/default/runs/{RUN}/final-go-4/commits/{"a" * 40}/_gate/attempt-1/record.json'


def _exact(message: str) -> str:
    return f'^{re.escape(message)}$'


def _epoch(text: str) -> int:
    """A UTC wall time as epoch seconds."""
    return int(datetime.fromisoformat(text).replace(tzinfo=UTC).timestamp())


def _verdict_rows(table: Any) -> list[dict[str, Any]]:
    return [row for row in _rows(table, 'STEP#') if row['record'] == 'verdict']


# ---- the caps ----

@pytest.mark.parametrize(('caps', 'message'), [
    ({'max_tasks': 0}, 'max_tasks is 1-10000'),
    ({'max_tasks': 1, 'max_tokens': 0}, 'max_tokens is a positive whole number'),
    ({'max_tasks': 1, 'max_cost_usd': 0.0}, 'max_cost_usd is a positive amount'),
], ids=['no-tasks', 'no-tokens', 'no-cost'])
def test_a_cap_that_is_no_real_limit_is_refused_saying_what_a_cap_is(caps: dict[str, Any], message: str) -> None:
    with pytest.raises(RuntimeRefused, match=_exact(message)):
        RunCaps(**caps)


def test_the_highest_caps_and_the_smallest_are_real_limits() -> None:
    assert RunCaps(max_tasks=10_000, max_tokens=1, max_cost_usd=0.01) == RunCaps(10_000, 1, 0.01)


def test_the_hard_cap_of_a_flow_with_no_id_says_a_budget_is_a_flows() -> None:
    with pytest.raises(RuntimeRefused, match=_exact("a budget is a flow's: the run names its workflow id")):
        hard_capped(RunCaps(max_tasks=5), budget_usd=10.0, flow='', table=None, now=NOV)


# ---- the run control ----

def test_the_control_reads_the_runs_own_caps_into_its_budget(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5, max_tokens=100, max_cost_usd=1.5), now=0)
    budget = TableRunControl(runs).budget(RUN)
    assert (budget.max_tokens, budget.max_cost_usd) == (100, 1.5)


def test_the_control_of_a_run_never_started_says_there_is_no_such_run(aws: Any) -> None:
    with pytest.raises(RunNotActive, match=_exact(f'no run {OTHER}')):
        TableRunControl(RunStore(aws[1])).budget(OTHER)


def test_only_an_active_run_is_active(aws: Any) -> None:
    runs = RunStore(aws[1])
    control = TableRunControl(runs)
    assert control.is_active(RUN) is False   # (never started)
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    assert control.is_active(RUN) is True
    runs.needs_human(RUN, 'budget', now=1)
    assert control.is_active(RUN) is False
    runs.resume(RUN, now=2)
    runs.end(RUN, 'done', now=3)
    assert control.is_active(RUN) is False


def test_a_coordinator_is_awaited_from_the_start_then_from_the_last_resume(aws: Any) -> None:
    runs = RunStore(aws[1])
    control = TableRunControl(runs)
    assert control.coordinator_awaited(RUN) is None   # (never started)
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=500, connection='conn-1', commit=COMMIT, language='python')
    assert control.coordinator_awaited(RUN) == 500
    runs.needs_human(RUN, 'coordinator', now=600)
    assert control.coordinator_awaited(RUN) is None   # (at a decision point)
    runs.resume(RUN, now=900)
    assert control.coordinator_awaited(RUN) == 900
    runs.end(RUN, 'stopped', now=1000)
    assert control.coordinator_awaited(RUN) is None


@pytest.mark.parametrize(('connection', 'commit', 'language'), [
    ('', COMMIT, 'python'), ('conn-1', '', 'python'), ('conn-1', COMMIT, ''), ('', '', 'python'), ('conn-1', '', '')],
    ids=['no-connection', 'no-commit', 'no-language', 'language-only', 'connection-only'])
def test_no_coordinator_is_awaited_without_a_connection_a_commit_and_a_language(
        aws: Any, connection: str, commit: str, language: str) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=500, connection=connection, commit=commit, language=language)
    assert TableRunControl(runs).coordinator_awaited(RUN) is None


class _Log:
    def __init__(self) -> None:
        self.lines: list[tuple[str, dict[str, Any]]] = []

    def exception(self, message: str, *, extra: dict[str, Any]) -> None:
        self.lines.append((message, extra))


def test_a_verdict_not_kept_at_a_flow_steps_decision_point_is_logged_naming_the_run_and_the_point(
        aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    log = _Log()

    def failing(_run_id: str) -> None:
        raise OSError('the table is away')

    monkeypatch.setattr(runs_module, 'logger', log)
    monkeypatch.setattr(runs, 'keep_verdicts', failing)
    TableRunControl(runs, clock=lambda: 60.0).needs_human(RUN, 'flow:human')
    assert log.lines == [('engineering runtime: a gate verdict for the run monitor was not kept',
                          {'run_id': RUN, 'decision_point': 'flow:human'})]


# ---- the budget alerts ----

def test_a_level_already_said_and_flagged_is_never_claimed_again(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0, flow='wf_fix', budget_usd=10.0)
    control = TableRunControl(runs)
    _spend(aws, '9')
    alert = control.budget_alert(RUN, NOV)
    assert alert is not None
    control.alert_sent(RUN, alert, NOV)
    claims: list[int] = []
    real = runs_module.claim_alert

    def counting(*args: Any, **kwargs: Any) -> Any:
        claims.append(args[3])
        return real(*args, **kwargs)

    monkeypatch.setattr(runs_module, 'claim_alert', counting)
    assert control.budget_alert(RUN, NOV + 60) is None
    assert claims == []


def test_a_claim_records_the_flows_month_total_it_was_made_at(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0, flow='wf_fix', budget_usd=10.0)
    _spend(aws, '9')
    assert TableRunControl(runs).budget_alert(RUN, NOV) is not None
    (claim,) = aws[1].query(KeyConditionExpression='pk = :pk AND begins_with(sk, :alert)', ExpressionAttributeValues={
        ':pk': 'WS#default#BUDGET#2026-11', ':alert': 'ALERT#'})['Items']
    assert claim['spent_usd'] == Decimal('9')


def test_a_run_held_back_by_another_runs_claim_is_not_flagged_at_all(aws: Any) -> None:
    runs, control = _two_runs_of_one_flow(aws)
    _spend(aws, '9')
    assert control.budget_alert(RUN, NOV) is not None   # (RUN claims 80%, unsaid)
    assert control.budget_alert(OTHER, NOV + 60) is None   # (held)
    other = runs.get(OTHER)
    assert other is not None
    assert (other.budget_alert, other.budget_alert_month) == (0, '')


def test_a_higher_level_of_the_month_before_is_said_in_the_next_months_first_minutes_though_its_flag_names_it(
        aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0, flow='wf_fix', budget_usd=10.0)
    control = TableRunControl(runs)
    _spend(aws, '8')
    first = control.budget_alert(RUN, NOV)
    assert first is not None
    control.alert_sent(RUN, first, NOV)   # (flagged: 80% of November)
    last_minute = _epoch('2026-11-30T23:59:40')
    _spend(aws, '2', at=last_minute)
    alert = control.budget_alert(RUN, _epoch('2026-12-01T00:00:20'))
    assert alert is not None
    assert (alert.month, alert.levels) == ('2026-11', (100,))


# ---- the flow plan ----

def _start_with_flow(runs: RunStore, run_id: str) -> None:
    runs.start(run_id, caps=RunCaps(max_tasks=10), now=86_400, flow='wf_understand', flow_definition=UNDERSTAND,
               flow_revision=4)


def _drop_copy(table: Any, run_id: str) -> None:
    table.delete_item(Key={'pk': f'WS#default#RUN#{run_id}', 'sk': FLOW_SK})


def test_a_runs_copy_of_its_flow_is_read_once_and_the_oldest_copy_leaves_a_full_cache(
        aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runs_module, 'CACHED_FLOWS', 2)
    runs = RunStore(aws[1])
    for run_id in (RUN, OTHER, THIRD):
        _start_with_flow(runs, run_id)
        assert runs.flow_plan(run_id) is not None
    for run_id in (RUN, THIRD):
        _drop_copy(aws[1], run_id)
    assert runs.flow_plan(THIRD) is not None   # (kept: never read again)
    assert runs.flow_plan(RUN) is None   # (the oldest, left the cache when the third came: read again, gone)


def test_the_plan_says_when_the_runs_task_cap_is_reached(aws: Any) -> None:
    runs = RunStore(aws[1])
    _start_with_flow(runs, RUN)
    plan = runs.flow_plan(RUN)
    assert plan is not None
    assert plan.cap_reached is False
    aws[1].update_item(Key=META, UpdateExpression='SET task_count = :n', ExpressionAttributeValues={':n': 10})
    plan = runs.flow_plan(RUN)
    assert plan is not None
    assert plan.cap_reached is True


def test_a_plan_reads_without_its_runs_meta_as_a_cap_not_reached(aws: Any) -> None:
    runs = RunStore(aws[1])
    _start_with_flow(runs, RUN)
    aws[1].delete_item(Key=META)
    plan = runs.flow_plan(RUN)
    assert plan is not None
    assert plan.cap_reached is False


def test_the_gate_record_read_is_the_deciding_final_gos_own(aws: Any) -> None:
    _no_go_at_the_gate(aws[1])
    asked: list[str] = []

    def reading(key: str) -> GateRecord:
        asked.append(key)
        return GateRecord.from_dict(gate_record('NO-GO'))

    plan = RunStore(aws[1], gate_records=reading).flow_plan(RUN)
    assert plan is not None
    assert asked == [FINAL_GO_KEY]


def test_without_a_gate_reader_the_verdict_the_board_recorded_decides(aws: Any) -> None:
    _no_go_at_the_gate(aws[1])
    aws[1].put_item(Item={'pk': PK, 'sk': 'STEP#gate#verdict#task-3', 'kind': 'step_record', 'step': 'gate',
                          'record': 'verdict', 'by': 'coordinator-1', 'at': 'now', 'task_id': 'task-3',
                          'verdict': NO_GO})
    plan = RunStore(aws[1]).flow_plan(RUN)
    assert plan is not None
    assert plan.decision_point == 'flow:human'


@pytest.mark.parametrize('read', [lambda runs: runs.flow_plan(RUN), lambda runs: runs.flow_plan(RUN, keep_verdicts=False)],
                         ids=['by-default', 'asked-not-to'])
def test_a_plan_not_asked_to_keep_verdicts_keeps_none(aws: Any, read: Any) -> None:
    runs = _no_go_at_the_gate(aws[1])
    plan = read(runs)
    assert plan.decision_point == 'flow:human'
    runs.keep_verdicts(RUN)
    assert _verdict_rows(aws[1]) == []


def test_no_verdict_is_kept_before_the_run_is_at_its_decision_point(aws: Any) -> None:
    runs = _no_go_at_the_gate(aws[1])
    aws[1].delete_item(Key={'pk': PK, 'sk': 'STEP#board#done'})   # (the hunt still on: the run is not at a person)
    plan = runs.flow_plan(RUN, keep_verdicts=True)
    assert plan is not None
    assert (plan.decision_point, dict(plan.verdicts)) == ('', {'gate': NO_GO})
    runs.keep_verdicts(RUN)
    assert _verdict_rows(aws[1]) == []


def test_keeping_verdicts_when_none_were_read_does_nothing(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.keep_verdicts(RUN)
    assert _verdict_rows(aws[1]) == []


def test_a_kept_verdict_is_stamped_with_the_time_it_was_kept(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = _no_go_at_the_gate(aws[1])
    TableRunControl(runs, clock=lambda: 90_000.0).flow_stop(RUN)
    monkeypatch.setattr(runs_module.time, 'time', lambda: 172_800.5)   # (the keeping reads the wall clock itself)
    runs.keep_verdicts(RUN)
    (kept,) = _verdict_rows(aws[1])
    assert kept['at'] == '1970-01-03T00:00:00Z'


def test_a_verdict_kept_meanwhile_by_the_board_is_never_written_over(aws: Any) -> None:
    runs = _no_go_at_the_gate(aws[1])
    plan = runs.flow_plan(RUN, keep_verdicts=True)
    assert plan is not None
    aws[1].put_item(Item={'pk': PK, 'sk': 'STEP#gate#verdict#task-3', 'kind': 'step_record', 'step': 'gate',
                          'record': 'verdict', 'by': 'coordinator-1', 'at': 'then', 'task_id': 'task-3',
                          'verdict': NO_GO})
    runs.keep_verdicts(RUN)   # (its create-only write is refused, quietly)
    (kept,) = _verdict_rows(aws[1])
    assert (kept['by'], kept['at']) == ('coordinator-1', 'then')


def _final_go(step: str) -> Task:
    return Task(task_id='task-3', role='final-go', state='done', title=step, spec='{}', spec_hash='h', depth=0,
                priority=0, attempt=1, lease_agent='final-go-4', updated_at='2026-11-13T10:00:00+00:00',
                flow_step=step)


def _plan(verdicts: dict[str, str]) -> Plan:
    return Plan(flow=Flow.from_definition(TEMPLATES['bug-hunt-and-fix']), steps={}, outcome='needs_human',
                at='human', verdicts=verdicts)


@pytest.mark.parametrize(('verdicts', 'tasks', 'kept'), [
    ({'gate': UNREAD}, [_final_go('gate')], []),
    ({'gate': GO}, [], []),
    ({'hunt': GO, 'gate': NO_GO}, [_final_go('gate')], [('STEP#gate#verdict#task-3', NO_GO)]),
], ids=['an-unread-verdict', 'no-final-go', 'one-skipped-then-the-next'])
def test_only_a_go_or_a_no_go_with_its_deciding_final_go_is_kept_for_each_gate(
        aws: Any, verdicts: dict[str, str], tasks: list[Task], kept: list[tuple[str, str]]) -> None:
    runs = RunStore(aws[1])
    runs._keep_verdicts(RUN, _plan(verdicts), tasks, {})
    assert [(row['sk'], row['verdict']) for row in _verdict_rows(aws[1])] == kept
