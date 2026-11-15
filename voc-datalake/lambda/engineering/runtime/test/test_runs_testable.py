"""The run store's requests pinned as sent (runtime/runs.py): every status change's, the budget flag's and every
read's DynamoDB expressions exactly, keyword case and all (DynamoDB reads its keywords in any case, so only the
requests as sent can tell a change of them); a status change's tries bounded by their count alone; a Resume of a run
that has no META refused before any write; the times as aware UTC."""
from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

import pytest
from botocore.exceptions import ClientError

from engineering.board.model import Task
from engineering.board.store import BoardStore
from engineering.connectors.identity import WORKSPACE
from engineering.flow.ledger import newest_ended, newest_final_go
from engineering.runtime import runs as runs_module
from engineering.runtime.runs import RunCaps, RunNotActive, RunStore
from engineering.runtime.test.conftest import RUN
from engineering.runtime.test.test_engineering_run_flow import _start

Requests = dict[str, list[dict[str, Any]]]


@pytest.fixture
def sent(aws: Any, monkeypatch: pytest.MonkeyPatch) -> Requests:
    """Every request the table and its client are sent, by operation, each still made on the moto table."""
    table, recorded = aws[1], {'transact': [], 'update': [], 'query': []}

    def recording(kind: str, real: Callable[..., Any]) -> Callable[..., Any]:
        def call(**request: Any) -> Any:
            recorded[kind].append(request)
            return real(**request)
        return call

    monkeypatch.setattr(table.meta.client, 'transact_write_items',
                        recording('transact', table.meta.client.transact_write_items))
    monkeypatch.setattr(table, 'update_item', recording('update', table.update_item))
    monkeypatch.setattr(table, 'query', recording('query', table.query))
    return recorded


def _meta_update(request: dict[str, Any]) -> dict[str, Any]:
    update = request['TransactItems'][0]['Update']
    return {name: update[name] for name in ('UpdateExpression', 'ConditionExpression')}


def test_an_end_is_this_exact_update(aws: Any, sent: Requests) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.end(RUN, 'done', now=60)
    assert _meta_update(sent['transact'][-1]) == {
        'UpdateExpression': 'SET #status = :status, ended_at = :ended',
        'ConditionExpression': '#status IN (:active, :human)'}


def test_a_decision_point_is_this_exact_update(aws: Any, sent: Requests) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.needs_human(RUN, 'budget', now=60)
    assert _meta_update(sent['transact'][-1]) == {
        'UpdateExpression': 'SET #status = :human, needs_human = :reason',
        'ConditionExpression': ('#status = :active OR (#status = :human AND needs_human <> :reason '
                                'AND needs_human <> :thirty)')}


def test_a_resume_is_this_exact_update(aws: Any, sent: Requests) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.needs_human(RUN, 'budget', now=60)
    runs.resume(RUN, now=120, actor='person-1')
    assert _meta_update(sent['transact'][-1]) == {
        'UpdateExpression': 'SET #status = :active, resumed_epoch = :now REMOVE needs_human',
        'ConditionExpression': '#status = :human AND needs_human <> :thirty'}


def test_a_resume_at_a_flow_steps_decision_point_holds_it_to_that_point(aws: Any, sent: Requests) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.needs_human(RUN, 'flow:review', now=60)
    runs.resume(RUN, now=120, actor='person-1')
    request = sent['transact'][-1]
    assert _meta_update(request) == {
        'UpdateExpression': 'SET #status = :active, resumed_epoch = :now REMOVE needs_human',
        'ConditionExpression': '#status = :human AND needs_human <> :thirty AND needs_human = :point'}
    assert request['TransactItems'][0]['Update']['ExpressionAttributeValues'][':point'] == 'flow:review'


def test_a_resume_of_a_run_never_started_is_refused_in_its_own_words_before_any_write(aws: Any,
                                                                                       sent: Requests) -> None:
    with pytest.raises(RunNotActive, match=f'^run {RUN} is not active$'):
        RunStore(aws[1]).resume(RUN, now=60)
    assert sent['transact'] == []


def test_the_budget_flag_is_this_exact_conditional_update(aws: Any, sent: Requests) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    runs.flag_budget(RUN, '2026-11', 50)
    (request,) = sent['update']
    assert (request['UpdateExpression'], request['ConditionExpression']) == (
        'SET budget_alert = :level, budget_alert_month = :month',
        ('attribute_exists(pk) AND (attribute_not_exists(budget_alert) OR budget_alert_month < :month '
        'OR (budget_alert_month = :month AND budget_alert < :level))'))


def test_every_read_is_this_exact_query(aws: Any, sent: Requests) -> None:
    runs = _start(aws[1])
    runs.listed()
    runs.spend(RUN)
    runs.flow_plan(RUN)
    assert [query['KeyConditionExpression'] for query in sent['query']] == [
        'pk = :runs AND begins_with(sk, :run)', 'pk = :run AND begins_with(sk, :agent)',
        'pk = :run AND begins_with(sk, :p)', 'pk = :run AND begins_with(sk, :p)']


def test_a_change_that_always_loses_the_race_raises_the_last_tries_own_error(
        aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    raised: list[ClientError] = []

    def always_racing(**_request: Any) -> Any:
        raised.append(ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': str(len(raised))},
                                   'CancellationReasons': [{'Code': 'TransactionConflict'}, {'Code': 'None'}]},
                                  'TransactWriteItems'))
        raise raised[-1]

    pauses: list[float] = []
    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', always_racing)
    monkeypatch.setattr(runs_module.time, 'sleep', pauses.append)
    with pytest.raises(ClientError) as caught:
        runs.end(RUN, 'stopped', now=60)
    assert (len(raised), caught.value) == (runs_module.STATUS_TRIES, raised[-1])
    # (a growing pause between tries, none before the first or after the last)
    assert pauses == [runs_module.STATUS_PAUSE_S * k for k in range(1, runs_module.STATUS_TRIES)]


def test_a_change_that_wins_on_its_last_try_is_made(aws: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=0)
    real, tries = aws[1].meta.client.transact_write_items, []

    def racing_until_the_last(**request: Any) -> Any:
        tries.append(1)
        if len(tries) < runs_module.STATUS_TRIES:
            raise ClientError({'Error': {'Code': 'TransactionCanceledException', 'Message': 'raced'},
                               'CancellationReasons': [{'Code': 'TransactionConflict'}]}, 'TransactWriteItems')
        return real(**request)

    pauses: list[float] = []
    monkeypatch.setattr(aws[1].meta.client, 'transact_write_items', racing_until_the_last)
    monkeypatch.setattr(runs_module.time, 'sleep', pauses.append)
    runs.end(RUN, 'stopped', now=60)
    run = runs.get(RUN)
    assert (len(tries), run.status if run else None) == (runs_module.STATUS_TRIES, 'stopped')
    assert pauses == [runs_module.STATUS_PAUSE_S * k for k in range(1, runs_module.STATUS_TRIES)]


def test_the_coordinators_task_is_the_boards_own_whoever_builds_it(aws: Any) -> None:
    runs = RunStore(aws[1])
    runs.start(RUN, caps=RunCaps(max_tasks=5), now=86_400)
    written = [aws[1].get_item(Key=key)['Item'] for key in (
        {'pk': f'WS#{WORKSPACE}#RUN#{RUN}', 'sk': 'TASK#coordinate'},)]
    expected = BoardStore(aws[1].meta.client, aws[1].name, new_id=lambda: '').coordinate_items(
        WORKSPACE, RUN, at='1970-01-02T00:00:00Z')[0]
    assert written == [expected]


@pytest.mark.parametrize('epoch', [0, 86_400.5, 1_795_000_000])
def test_every_time_is_an_aware_utc_time(epoch: float) -> None:
    at = runs_module.utc(epoch)
    assert (at.tzinfo, at.timestamp()) == (UTC, epoch)


@pytest.mark.parametrize('epoch', [0, 86_400, 1_795_000_000])
def test_a_status_rows_time_is_utc_with_its_z(epoch: int) -> None:
    assert runs_module._iso(epoch) == datetime.fromtimestamp(epoch, UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---- the deciding final go, its task alone (flow/ledger.py ``newest_ended``) ----

def _task(task_id: str, role: str = 'final-go', state: str = 'done', at: str = '2026-11-14T10:00:00Z',
          attempt: int = 1) -> Task:
    return Task(task_id=task_id, role=role, state=state, title='t', spec='{}', spec_hash='h', depth=0, priority=0,
                attempt=attempt, updated_at=at)


def test_the_deciding_task_is_the_one_of_its_role_that_ended_last_then_on_its_latest_attempt() -> None:
    tasks = [_task('old', at='2026-11-14T09:00:00Z'), _task('new', state='failed'), _task('open', state='open',
             at='2026-11-14T11:00:00Z'), _task('runner', role='gate-runner', at='2026-11-14T12:00:00Z'),
             _task('retried', attempt=2)]
    latest = newest_ended(tasks, 'final-go')
    assert latest is not None
    assert latest.task_id == 'retried'


def test_no_ended_task_of_the_role_decides_nothing() -> None:
    assert newest_ended([_task('open', state='open'), _task('runner', role='gate-runner')], 'final-go') is None


def test_the_record_reader_takes_the_same_deciding_task() -> None:
    tasks = [_task('a', at='2026-11-14T09:00:00Z'), _task('b', at='2026-11-14T10:00:00Z')]
    found = newest_final_go(tasks, WORKSPACE, RUN)
    assert found is not None
    assert (found[0].task_id, found[1]) == ('b', '')
