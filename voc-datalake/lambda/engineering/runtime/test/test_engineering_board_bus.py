"""The supervisor's board and bus (board_bus.py): a task's lease as the supervisor reads it, its re-post, and each
of the supervisor's kinds as a voc-msg/1 message with the supervisor's source."""
from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from itertools import count
from typing import Any

import pytest

from engineering.board.store import LEASE_S, BoardError, BoardStore
from engineering.board.test.table import RUN, TABLE, engineering_table
from engineering.bus.publish import EventBridgePublisher
from engineering.bus.schema import MAX_SUMMARY_BYTES, parse
from engineering.bus.senders import judge
from engineering.connectors.identity import WORKSPACE
from engineering.runtime import board_bus
from engineering.runtime.board_bus import SOURCE, TYPES, BoardLeases, SupervisorBus
from engineering.runtime.ports import Lease

AT = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)


class Events:
    """EventBridge as the publisher sees it: records each entry, refuses none."""

    entries: list[dict[str, Any]]

    def __init__(self) -> None:
        self.entries = []

    def put_events(self, **request: Any) -> dict[str, int]:
        self.entries += request['Entries']
        return {'FailedEntryCount': 0}

    def details(self) -> list[dict[str, Any]]:
        return [json.loads(entry['Detail']) for entry in self.entries]


@pytest.fixture
def board() -> Iterator[tuple[BoardStore, BoardLeases, Events]]:
    with engineering_table() as client:
        # A second on for every read of the clock: the history rows are keyed by time, as on a live board.
        seconds = count()
        store = BoardStore(client, TABLE, new_id=lambda: 'task-1', now=lambda: AT + timedelta(seconds=next(seconds)))
        events = Events()
        yield store, BoardLeases(store, EventBridgePublisher(events, 'voc-engineering', SOURCE)), events


def _posted(store: BoardStore) -> str:
    return store.post(WORKSPACE, RUN, role='fixer', title='Fix the parser', spec={'issue': 7}, parent_task='',
                      priority=1, actor='coordinator-0').task.task_id


def test_a_claimed_tasks_lease_reads_its_holder_heartbeat_progress_and_wait(board: Any):
    store, leases, _ = board
    task_id = _posted(store)
    # Open: nobody holds it, at its attempt.
    assert leases.lease(RUN, task_id) == Lease(task_id=task_id, agent_id='', renewed_at=0, last_progress_at=0)
    claimed = store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
    reported = store.progress(WORKSPACE, RUN, task_id, agent='fixer-1', epoch=claimed.lease_epoch,
                              step='reading the parser', waiting=True)
    assert reported.progress_at > int(AT.timestamp())
    assert leases.lease(RUN, task_id) == Lease(task_id=task_id, agent_id='fixer-1',
                                               renewed_at=claimed.lease_expires - LEASE_S,
                                               last_progress_at=reported.progress_at, waiting=True)


@pytest.mark.parametrize('task_id', ['', 'task-missing'])
def test_no_task_or_one_not_on_the_board_has_no_lease(board: Any, task_id: str):
    _, leases, _ = board
    assert leases.lease(RUN, task_id) is None


def test_a_repost_frees_the_task_at_its_next_attempt_and_posts_it_as_the_supervisor(board: Any):
    store, leases, events = board
    task_id = _posted(store)
    store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
    leases.repost(RUN, task_id, 'stalled', attempt=1)
    task = store.task(WORKSPACE, RUN, task_id)
    assert (task.state, task.attempt, task.lease_agent, leases.lease(RUN, task_id)) == (
        'open', 2, '', Lease(task_id=task_id, agent_id='', renewed_at=0, last_progress_at=0, attempt=2))
    [entry] = events.entries
    detail = parse(json.loads(entry['Detail']))
    assert (entry['Source'], detail.type, detail.to.kind, detail.to.id, detail.attempt) == (
        SOURCE, 'task.posted', 'role', 'fixer', 2)
    # The router admits it: the supervisor may post a re-posted task, as itself.
    assert judge(detail, entry['Source']).allowed


def test_a_repost_of_an_attempt_that_has_moved_on_is_refused_and_one_that_has_ended_is_left(board: Any):
    store, leases, events = board
    task_id = _posted(store)
    store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
    with pytest.raises(BoardError, match='attempt'):
        leases.repost(RUN, task_id, 'stalled', attempt=5)
    claimed = store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
    store.move(WORKSPACE, RUN, task_id, agent='fixer-1', epoch=claimed.lease_epoch, to_state='in_progress',
               result_keys=[])
    store.move(WORKSPACE, RUN, task_id, agent='fixer-1', epoch=claimed.lease_epoch, to_state='done', result_keys=[])
    leases.repost(RUN, task_id, 'crashed', attempt=1)
    assert (store.task(WORKSPACE, RUN, task_id).state, events.entries) == ('done', [])


@pytest.mark.parametrize('kind', list(TYPES))
def test_every_kind_the_supervisor_emits_passes_the_routers_sender_check(kind: str):
    message = board_bus.message(RUN, 'run' if kind in ('run.health', 'continued', 'timed_out', 'failed') else 'fixer-1',
                                TYPES[kind], 'x', None, task_id='task-1', attempt=1, at=AT)
    assert judge(message, SOURCE).allowed, kind


@pytest.mark.parametrize(('kind', 'to'), [(kind, 'run' if kind.startswith('run') or kind in
                                           ('continued', 'timed_out', 'failed') else 'fixer-1') for kind in TYPES])
def test_each_of_the_supervisors_kinds_goes_out_as_its_type_with_the_supervisors_source(kind: str, to: str):
    events = Events()
    SupervisorBus(EventBridgePublisher(events, 'voc-engineering', SOURCE)).emit(
        RUN, to, kind, 'fixer-1 continued in a new MicroVM.', {'continuation': '2', 'after': 'crash'},
        task_id='task-1', attempt=3)
    [entry] = events.entries
    message = parse(json.loads(entry['Detail']))
    assert (entry['Source'], entry['DetailType'], message.type) == (SOURCE, TYPES[kind], TYPES[kind])
    assert (message.sender.kind, message.sender.id, message.thread_id, message.task_id, message.attempt) == (
        'supervisor', 'supervisor', RUN, 'task-1', 3)
    assert (message.to.kind, message.to.id) == (('run', RUN) if to == 'run' else ('agent', 'fixer-1'))
    # Its figures are in its summary: a message's refs hold only object keys, a commit, a PR and files.
    assert (message.summary, message.refs.s3) == ('fixer-1 continued in a new MicroVM. (continuation 2, after crash)', ())


def test_a_kind_the_supervisor_does_not_emit_is_refused_before_anything_is_sent():
    events = Events()
    with pytest.raises(ValueError, match="emits no 'progress'"):
        SupervisorBus(EventBridgePublisher(events, 'voc-engineering', SOURCE)).emit(RUN, 'run', 'progress', 'x')
    assert events.entries == []


def test_a_long_summary_is_cut_to_the_schemas_bytes_on_a_character():
    message = board_bus.message(RUN, 'run', 'run.health', 'é' * MAX_SUMMARY_BYTES, None, task_id='', attempt=0, at=AT)
    assert (len(message.summary.encode('utf-8')) <= MAX_SUMMARY_BYTES, message.summary[-1], message.attempt,
            message.at) == (True, 'é', 1, '2026-11-12T12:00:00.000000Z')
    assert parse(message.to_dict()) == message


def test_a_holders_lease_that_ran_out_is_refreshed_and_anyone_elses_refused(board: Any):
    store, leases, _ = board
    task_id = _posted(store)
    claimed = store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
    # Its lease long run out (a Resume long after a Pause): refreshed for its holder, at its epoch.
    store.client.update_item(TableName=TABLE, Key={'pk': {'S': f'WS#{WORKSPACE}#RUN#{RUN}'},
                                                   'sk': {'S': f'TASK#{task_id}'}},
                             UpdateExpression='SET lease_expires = :past', ExpressionAttributeValues={':past': {'N': '1'}})
    assert leases.refresh(RUN, task_id, agent_id='fixer-1', attempt=claimed.lease_epoch)
    assert store.task(WORKSPACE, RUN, task_id).lease_expires > int(AT.timestamp())
    assert not leases.refresh(RUN, task_id, agent_id='fixer-2', attempt=claimed.lease_epoch)
    assert not leases.refresh(RUN, task_id, agent_id='fixer-1', attempt=claimed.lease_epoch + 1)


@pytest.mark.parametrize('final', ['done', None])
def test_no_lease_is_refreshed_on_a_task_that_has_ended_or_is_open(board: Any, final: str | None):
    store, leases, _ = board
    task_id = _posted(store)
    if final is not None:
        claimed = store.claim(WORKSPACE, RUN, task_id, role='fixer', agent='fixer-1')
        for state in ('in_progress', final):
            store.move(WORKSPACE, RUN, task_id, agent='fixer-1', epoch=claimed.lease_epoch, to_state=state,
                       result_keys=[])
    assert not leases.refresh(RUN, task_id, agent_id='fixer-1', attempt=1)


def test_a_task_never_claimed_is_left_open_never_reposted(board: Any):
    store, leases, events = board
    task_id = _posted(store)
    # Its agent crashed before its harness claimed it: open at attempt 1, nothing to re-post.
    leases.repost(RUN, task_id, 'crashed', attempt=1)
    task = store.task(WORKSPACE, RUN, task_id)
    assert (task.state, task.attempt, events.entries) == ('open', 1, [])


def test_a_task_whose_launched_agent_never_claimed_it_is_reposted_at_its_next_attempt(board: Any):
    store, leases, events = board
    task_id = _posted(store)
    store.launch(WORKSPACE, RUN, task_id, role='fixer', actor='coordinator-0', paths=('src',), language='python')
    leases.repost(RUN, task_id, 'crashed', attempt=1)
    task = store.task(WORKSPACE, RUN, task_id)
    assert (task.state, task.attempt, [json.loads(entry['Detail'])['type'] for entry in events.entries]) == (
        'open', 2, ['task.posted'])
