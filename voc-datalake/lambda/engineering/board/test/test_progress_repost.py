"""The holder's progress reports, the supervisor's re-post of a task whose lease ran out, and the SPEC# dedupe once
the equal task has ended: the store's conditional writes and the board API's op and events."""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from itertools import count
from typing import Any

import pytest

from engineering.board.api import BoardApi, repost_task
from engineering.board.inbox import Inbox
from engineering.board.store import LEASE_S, MAX_LINE, BoardError, BoardStore
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.bus.publish import EventBridgePublisher
from engineering.bus.schema import parse
from engineering.connectors.identity import Caller
from engineering.quality_gate.text import redact
from engineering.rows import run_pk

WS = 'default'
START = datetime(2026, 11, 12, 9, 0, tzinfo=UTC)
FIXER = Caller('fixer', RUN, 1)


@dataclass
class Board:
    client: Any
    store: BoardStore
    clock: list[datetime] = field(default_factory=lambda: [START])

    def tick(self, seconds: int) -> None:
        self.clock[0] += timedelta(seconds=seconds)

    def finish(self, task_id: str, state: str = 'done') -> None:
        """The holder takes its task to an end (through in_progress for done)."""
        if state == 'done':
            self.tick(1)
            self.store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state='in_progress', result_keys=[])
        self.tick(1)
        self.store.move(WS, RUN, task_id, agent='fixer-1', epoch=1, to_state=state, result_keys=[])


@pytest.fixture
def board() -> Iterator[Board]:
    with engineering_table() as client:
        clock = [START]
        ids = count(1)
        store = BoardStore(client, TABLE, new_id=lambda: f'task-{next(ids)}', now=lambda: clock[0])
        yield Board(client, store, clock)


def post(store: BoardStore, spec: dict[str, Any] | None = None) -> str:
    return store.post(WS, RUN, role='fixer', title='Fix the page size', spec=spec or {'issue': 1}, parent_task='',
                      priority=0, actor='coordinator-0').task.task_id


def claimed(board: Board) -> str:
    task_id = post(board.store)
    board.tick(1)
    board.store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    board.tick(1)
    return task_id


def kind(call: Any) -> str:
    with pytest.raises(BoardError) as caught:
        call()
    return caught.value.kind


# --- progress ---------------------------------------------------------------------------------------------------

def test_the_holder_reports_its_progress_step_and_whether_it_waits(board: Board) -> None:
    task_id = claimed(board)
    board.tick(30)
    task = board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step=' Wrote the failing test ',
                                waiting=False)
    assert (task.progress_at, task.step, task.waiting) == (int(START.timestamp()) + 32, 'Wrote the failing test', False)
    waiting = board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step='Asked the reviewer', waiting=True)
    assert waiting.view()['progress'] == {'at': int(START.timestamp()) + 32, 'step': 'Asked the reviewer',
                                          'waiting': True}
    assert [move.op for move in board.store.history(WS, RUN)[task_id]] == ['post', 'claim']   # (not a move)


def test_only_the_holder_with_its_epoch_on_a_live_lease_reports(board: Board) -> None:
    task_id = claimed(board)
    report = board.store.progress
    assert kind(lambda: report(WS, RUN, task_id, agent='fixer-2', epoch=1, step='x', waiting=False)) == 'conflict'
    assert kind(lambda: report(WS, RUN, task_id, agent='fixer-1', epoch=2, step='x', waiting=False)) == 'conflict'
    board.tick(LEASE_S + 1)
    assert kind(lambda: report(WS, RUN, task_id, agent='fixer-1', epoch=1, step='x', waiting=False)) == 'conflict'


def test_a_waiting_holder_keeps_its_lease_past_expiry_and_clears_waiting_when_it_resumes(board: Board) -> None:
    task_id = claimed(board)
    board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step='Asked a question', waiting=True)
    board.tick(LEASE_S * 3)   # suspended on its wait: no heartbeat
    board.store.renew(WS, RUN, task_id, agent='fixer-1', epoch=1)
    resumed = board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step='Got the answer', waiting=False)
    assert (resumed.waiting, resumed.step) == (False, 'Got the answer')
    board.tick(LEASE_S * 3)   # no longer waiting, no heartbeat: the lease is lost
    assert kind(lambda: board.store.renew(WS, RUN, task_id, agent='fixer-1', epoch=1)) == 'conflict'


def test_an_ended_task_takes_no_progress(board: Board) -> None:
    task_id = claimed(board)
    board.finish(task_id, 'failed')
    assert kind(lambda: board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step='x',
                                             waiting=False)) == 'conflict'


def test_a_step_is_one_bounded_line_with_nothing_secret(board: Board) -> None:
    task_id = claimed(board)
    report = board.store.progress
    assert kind(lambda: report(WS, RUN, task_id, agent='fixer-1', epoch=1, step='  ', waiting=False)) == 'invalid'
    assert kind(lambda: report(WS, RUN, task_id, agent='fixer-1', epoch=1, step='x' * (MAX_LINE + 1),
                               waiting=False)) == 'invalid'
    secret = report(WS, RUN, task_id, agent='fixer-1', epoch=1, step='key AKIA' + 'ABCDEFGHIJKLMNOP', waiting=False)
    assert 'AKIA' not in secret.step


# --- repost -----------------------------------------------------------------------------------------------------

def test_an_expired_task_is_open_again_at_the_next_attempt_with_its_reason_kept(board: Board) -> None:
    task_id = claimed(board)
    board.store.progress(WS, RUN, task_id, agent='fixer-1', epoch=1, step='Waiting', waiting=True)
    board.tick(LEASE_S + 1)
    task = board.store.repost(WS, RUN, task_id, reason=' lease ran out after 5 minutes ')
    assert (task.state, task.attempt, task.lease_agent, task.view()['lease'], task.waiting) == (
        'open', 2, '', None, False)
    last = board.store.history(WS, RUN)[task_id][-1]
    assert (last.op, last.actor, last.attempt, last.view()['reason']) == (
        'repost', 'supervisor', 2, 'lease ran out after 5 minutes')
    assert task.view()['progress'] is None   # the last attempt's progress went with its lease
    again = board.store.claim(WS, RUN, task_id, role='fixer', agent='fixer-2')
    assert (again.lease_agent, again.lease_epoch, again.progress_at) == ('fixer-2', 2, 0)   # epoch: the new attempt


def test_an_open_or_ended_task_is_not_reposted(board: Board) -> None:
    task_id = post(board.store)
    assert kind(lambda: board.store.repost(WS, RUN, task_id, reason='x')) == 'conflict'
    board.tick(1)
    board.store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    board.finish(task_id, 'needs_human')
    assert kind(lambda: board.store.repost(WS, RUN, task_id, reason='x')) == 'conflict'


def test_a_second_repost_of_the_same_attempt_changes_nothing(board: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    task_id = claimed(board)
    stale = board.store.task(WS, RUN, task_id)
    first = board.store.repost(WS, RUN, task_id, reason='expired')
    board.tick(1)
    # A second supervisor tick read the task before the first re-post landed: it answers the task as it is.
    real, reads = board.store.task, count()
    monkeypatch.setattr(board.store, 'task', lambda *args: stale if next(reads) == 0 else real(*args))
    second = board.store.repost(WS, RUN, task_id, reason='expired')
    monkeypatch.undo()
    assert (second, first.attempt, len(board.store.history(WS, RUN)[task_id])) == (
        board.store.task(WS, RUN, task_id), 2, 3)


def test_a_reason_is_a_bounded_line_with_nothing_secret(board: Board) -> None:
    task_id = claimed(board)
    task = board.store.repost(WS, RUN, task_id, reason='token AKIA' + 'ABCDEFGHIJKLMNOP ' + 'x' * 400)
    reason = board.store.history(WS, RUN)[task.task_id][-1].reason
    assert (len(reason) <= MAX_LINE, 'AKIA' in reason) == (True, False)


# --- the SPEC# dedupe once the equal task ended -------------------------------------------------------------------

def test_a_post_equal_to_an_ended_task_is_new_work(board: Board) -> None:
    first = claimed(board)
    board.finish(first, 'failed')
    again = board.store.post(WS, RUN, role='fixer', title='Fix the page size', spec={'issue': 1}, parent_task='',
                             priority=0, actor='coordinator-0')
    marker = board.client.get_item(TableName=TABLE, Key={'pk': {'S': run_pk(WS, RUN)}, 'sk': {
        'S': f'SPEC#{again.task.spec_hash}'}})['Item']
    assert (again.created, again.task.task_id != first, marker['task_id']['S']) == (True, True, again.task.task_id)


def test_a_post_equal_to_a_task_under_way_is_answered_with_it(board: Board) -> None:
    first = claimed(board)
    again = board.store.post(WS, RUN, role='fixer', title='Fix the page size', spec={'issue': 1}, parent_task='',
                             priority=0, actor='coordinator-0')
    assert (again.created, again.task.task_id) == (False, first)


def test_two_posts_racing_after_an_end_make_one_task(board: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    first = claimed(board)
    board.finish(first)
    winner = board.store.post(WS, RUN, role='fixer', title='Fix the page size', spec={'issue': 1}, parent_task='',
                              priority=0, actor='coordinator-0').task
    # The racing post's first read is of the marker before the winner moved it.
    original = board.store._get
    calls = count()

    def stale_marker(key: Any) -> Any:
        item = original(key)
        if key['sk']['S'].startswith('SPEC#') and next(calls) == 0:
            return {**(item or {}), 'task_id': {'S': first}}
        return item

    monkeypatch.setattr(board.store, '_get', stale_marker)
    loser = board.store.post(WS, RUN, role='fixer', title='Fix the page size', spec={'issue': 1}, parent_task='',
                             priority=0, actor='coordinator-0')
    assert (loser.created, loser.task.task_id) == (False, winner.task_id)


def test_a_marker_that_keeps_moving_is_a_conflict(board: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    first = claimed(board)
    board.finish(first)
    second = post(board.store)   # a new task, the marker on it
    board.tick(1)
    board.store.claim(WS, RUN, second, role='fixer', agent='fixer-1')
    board.finish(second)
    # Every read of the marker names the first, ended, task: the marker keeps moving under this post.
    original = board.store._get
    monkeypatch.setattr(board.store, '_get', lambda key: ({**(original(key) or {}), 'task_id': {'S': first}}
                                                          if key['sk']['S'].startswith('SPEC#') else original(key)))
    assert kind(lambda: post(board.store)) == 'conflict'


# --- the API ----------------------------------------------------------------------------------------------------

class Bus:
    def __init__(self) -> None:
        self.entries: list[dict[str, Any]] = []

    def put_events(self, Entries: list[dict[str, Any]]) -> dict[str, Any]:  # (boto3's keyword)
        self.entries.extend(Entries)
        return {'FailedEntryCount': 0, 'Entries': [{'EventId': 'e'}]}

    def messages(self) -> list[Any]:
        return [parse(json.loads(entry['Detail'])) for entry in self.entries]


def _call(api: BoardApi, **body: Any) -> tuple[int, dict[str, Any]]:
    answer = api.handle_request(FIXER, json.dumps(body))
    return answer['statusCode'], json.loads(answer['body'])


def test_the_progress_op_publishes_task_progress_and_a_retry_is_the_same_event(board: Board) -> None:
    bus = Bus()
    api = BoardApi(board.store, EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/board'),
                   Inbox(board.client, TABLE))
    task_id = claimed(board)
    status, body = _call(api, op='progress', task_id=task_id, epoch=1, step='Ran the tests', waiting=True)
    assert (status, body['task']['progress']['step'], body['task']['progress']['waiting']) == (
        200, 'Ran the tests', True)
    _call(api, op='progress', task_id=task_id, epoch=1, step='Ran the tests', waiting=True)
    first, again = bus.messages()
    assert (first.type, first.to.kind, first.summary, first.event_id) == (
        'task.progress', 'run', 'progress: Fix the page size: Ran the tests (waiting)', again.event_id)
    assert _call(api, op='progress', task_id=task_id, epoch=1, step='x', waiting='yes')[0] == 400
    assert _call(api, op='progress', task_id=task_id, epoch=2, step='x')[0] == 409


def _api(board: Board, bus: Bus) -> BoardApi:
    return BoardApi(board.store, EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/board'),
                    Inbox(board.client, TABLE))


def test_two_reports_in_one_second_are_two_events(board: Board) -> None:
    bus = Bus()
    api = _api(board, bus)
    task_id = claimed(board)
    _call(api, op='progress', task_id=task_id, epoch=1, step='Ran the tests', waiting=False)
    _call(api, op='progress', task_id=task_id, epoch=1, step='Ran the tests', waiting=True)   # (the same second)
    first, second = bus.messages()
    assert first.event_id != second.event_id


def test_a_long_report_in_any_language_fits_its_event(board: Board) -> None:
    bus = Bus()
    api = _api(board, bus)
    task_id = board.store.post(WS, RUN, role='fixer', title='頁' * 200, spec={'issue': 9}, parent_task='',
                               priority=0, actor='coordinator-0').task.task_id
    board.tick(1)
    board.store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    status, _ = _call(api, op='progress', task_id=task_id, epoch=1, step='測' * MAX_LINE, waiting=False)
    (event,) = bus.messages()
    assert (status, len(event.summary.encode('utf-8')) <= 1024) == (200, True)


def test_a_title_and_a_step_never_join_into_a_secret_shape(board: Board) -> None:
    """``api_token`` then ``: <value>`` would read as a credential's line; the summary starts ``progress:``, so it never
    does, and the event passes the schema (which refuses a summary the redaction would change)."""
    bus = Bus()
    api = _api(board, bus)
    task_id = board.store.post(WS, RUN, role='fixer', title='api_token', spec={'issue': 10}, parent_task='',
                               priority=0, actor='coordinator-0').task.task_id
    board.tick(1)
    board.store.claim(WS, RUN, task_id, role='fixer', agent='fixer-1')
    step = 'abcdefgh' + '12345678'   # (in two parts: a secret scanner reads the joined shape too)
    status, _ = _call(api, op='progress', task_id=task_id, epoch=1, step=step, waiting=False)
    (event,) = bus.messages()
    assert (status, event.summary, redact(event.summary) == event.summary) == (
        200, f'progress: api_token: {step}', True)


def test_an_event_that_cannot_be_built_answers_400_not_500(board: Board, monkeypatch: pytest.MonkeyPatch) -> None:
    api = _api(board, Bus())
    task_id = claimed(board)
    monkeypatch.setattr('engineering.board.api._progress_summary', lambda _task: 'x' * 2000)
    assert _call(api, op='progress', task_id=task_id, epoch=1, step='Ran the tests', waiting=False)[0] == 400


def test_repost_task_publishes_the_task_again_to_its_role(board: Board) -> None:
    bus = Bus()
    publisher = EventBridgePublisher(bus, 'voc-engineering', 'voc.engineering/board')
    task_id = claimed(board)
    task = repost_task(board.store, publisher, WS, RUN, task_id, 'lease ran out')
    # A retry after a lost event: already open at the next attempt, so the same event again.
    assert repost_task(board.store, publisher, WS, RUN, task_id, 'lease ran out') == task
    first, again = bus.messages()
    assert (first.type, first.to.kind, first.to.id, first.attempt, first.event_id) == (
        'task.posted', 'role', 'fixer', 2, again.event_id)


def test_repost_task_raises_for_a_task_never_reposted(board: Board) -> None:
    task_id = post(board.store)
    publisher = EventBridgePublisher(Bus(), 'voc-engineering', 'voc.engineering/board')
    assert kind(lambda: repost_task(board.store, publisher, WS, RUN, task_id, 'x')) == 'conflict'
