"""voc-engineering-delivery: a message lands once in its run's inbox, and its addressees are woken to read it."""
import json
from dataclasses import replace
from typing import Any

import pytest

from engineering.bus.test.messages import message
from engineering.runtime import delivery
from engineering.runtime.caps import Timings
from engineering.runtime.delivery import AddresseeBusy, deliver
from engineering.runtime.interface import RuntimeRefused, RuntimeSession
from engineering.runtime.sessions import AgentSession
from engineering.runtime.test.conftest import RUN, World

SLEEP = 'import time; time.sleep(60)'
T = Timings()
LEASE = f'{RUN}/task-1'


def _for(to: dict[str, str], **changes: Any) -> dict[str, Any]:
    """A message of this run, from the run's conductor, to ``to``."""
    defaults: dict[str, Any] = {'from': {'kind': 'conductor', 'id': 'conductor'},
                                'refs': {'s3': [f'ws/default/runs/{RUN}/coordinator-0/notes/plan.md']}}
    return message(run_id=RUN, to=to, **(defaults | changes))


def _deliver(world: World, raw: dict[str, Any], now: int, seq: int | None = 7) -> dict[str, Any]:
    event: dict[str, Any] = {'message': raw} if seq is None else {'message': raw, 'seq': seq}
    return deliver(event, table=world.store._table, supervisor=world.supervisor, now=now)


def _inbox(world: World) -> list[dict[str, Any]]:
    rows = world.store._table.scan()['Items']
    return sorted((row for row in rows if str(row['sk']).startswith('INBOX#')), key=lambda row: str(row['sk']))


def _until(world: World, now: int, status: str, agent_id: str = 'fixer-1') -> AgentSession:
    for _ in range(300):
        world.renew(now, agent_id=agent_id, task_id=world.session(agent_id).task_id)
        world.supervisor.tick(now)
        if world.session(agent_id).status == status:
            return world.session(agent_id)
    raise AssertionError(f'{agent_id} never became {status}')


def _suspended_on_an_open_wait(world: World) -> AgentSession:
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    world.board.leases[LEASE] = replace(world.board.leases[LEASE], waiting=True)
    world.supervisor.tick(1001)
    assert world.session().suspended
    return world.session()


def _working_from(world: World, tick: int) -> int:
    """Tick every minute from ``tick`` until the agent works; the tick it first does."""
    while world.session().status != 'working':
        tick += 60
        world.supervisor.tick(tick)
    return tick


def _continued_by_a_message(world: World) -> int:
    """An agent held past its wait's 45 minutes, the wait still open, continued by a message and working again; the
    tick it first works."""
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    world.board.leases[LEASE] = replace(world.board.leases[LEASE], waiting=True)
    world.store.save(replace(world.session(), status='waiting', wait_since=1001))
    now = 1001 + T.wait_suspend_limit + 60
    _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), now)
    return _working_from(world, now)


def test_a_message_is_recorded_once_in_its_runs_inbox_in_the_agreed_shape(world: World):
    raw = _for({'kind': 'agent', 'id': 'fixer-1'}, task_id='task-1')
    assert _deliver(world, raw, 1000)['recorded'] is True
    # A redelivery (the router keeps the message's seq) writes nothing.
    assert _deliver(world, raw, 1005)['recorded'] is False
    [row] = _inbox(world)
    assert row['pk'] == f'WS#default#RUN#{RUN}'
    # Under its write-order number (the run's first notice), the conversation's seq kept beside it.
    assert row['sk'] == f'INBOX#agent:fixer-1#{1:012d}#{raw["event_id"]}'
    assert (row['inbox_seq'], row['seq'], row['type'], row['from_kind'], row['from_id'], row['task_id'],
            row['at']) == (1, 7, 'msg.question', 'conductor', 'conductor', 'task-1', 1000)
    table = world.store._table
    marker = table.get_item(Key={'pk': row['pk'], 'sk': f'INBOXEVT#{raw["event_id"]}'})['Item']
    meta = table.get_item(Key={'pk': row['pk'], 'sk': 'META'})['Item']
    # The redelivery found the marker: it took no number.
    assert (marker['inbox_seq'], marker['addressee'], meta['inbox_seq']) == (1, 'agent:fixer-1', 1)
    assert json.loads(row['refs']) == {'s3': [f'ws/default/runs/{RUN}/coordinator-0/notes/plan.md']}
    assert row['summary'] == raw['summary']


def test_a_notice_delivered_late_gets_a_number_above_every_one_already_read(world: World):
    late = _for({'kind': 'agent', 'id': 'fixer-1'})
    for seq in (11, 12):
        _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1000, seq=seq)
    # Conversation seq 10, retried a minute later: its write-order number is the next one, so a reader whose
    # cursor passed 11 and 12 still reads it.
    _deliver(world, late, 1060, seq=10)
    rows = {row['event_id']: row for row in _inbox(world)}
    assert (rows[late['event_id']]['inbox_seq'], rows[late['event_id']]['seq']) == (3, 10)


def test_a_redelivery_racing_the_first_writes_nothing_and_its_number_is_a_gap(world: World,
                                                                              monkeypatch: pytest.MonkeyPatch):
    raw = _for({'kind': 'agent', 'id': 'fixer-1'})
    _deliver(world, raw, 1000)
    # The second delivery read before the first's marker was written: it takes a number, and its marker is refused.
    monkeypatch.setattr(delivery, 'consistent_item', lambda _table, _key: None)
    assert _deliver(world, raw, 1001)['recorded'] is False
    meta = world.store._table.get_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'META'})['Item']
    assert (len(_inbox(world)), meta['inbox_seq']) == (1, 2)


def test_a_run_without_its_meta_has_no_inbox(world: World):
    world.store._table.delete_item(Key={'pk': f'WS#default#RUN#{RUN}', 'sk': 'META'})
    with pytest.raises(RuntimeRefused, match='no META'):
        _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1000)
    assert _inbox(world) == []


@pytest.mark.parametrize(('to', 'kind', 'key'), [
    ({'kind': 'conductor', 'id': 'conductor'}, 'msg.question', 'conductor'),
    ({'kind': 'role', 'id': 'fixer'}, 'task.posted', 'role:fixer'),
], ids=['conductor', 'posted-task'])
def test_the_conductor_and_a_role_each_have_one_inbox(world: World, to: dict[str, str], kind: str, key: str):
    _deliver(world, _for(to, type=kind, **({'task_id': 'task-9'} if kind == 'task.posted' else {})), 1000)
    assert [str(row['sk']).split('#')[1] for row in _inbox(world)] == [key]


def test_a_message_wakes_a_suspended_addressee_which_stays_awake_to_read_it(world: World):
    suspended = _suspended_on_an_open_wait(world)
    calls = len(world.sts.calls)
    # 20 minutes into the wait: its 15-minute role session has lapsed meanwhile.
    now = 1001 + 20 * 60
    answer = _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), now)
    assert answer['woken'] == {'fixer-1': 'working'}
    woken = world.session()
    # Resumed, with a fresh role session, and marked so the open wait does not suspend it again at once.
    assert (woken.suspended, woken.woken_at, len(world.sts.calls)) == (False, now, calls + 1)
    assert world.runtime.state_of(suspended.vm) == 'running'
    world.supervisor.tick(now + T.wake_grace - 1)
    assert world.session().suspended is False
    # Its wait still open after the grace: suspended again.
    world.supervisor.tick(now + T.wake_grace)
    assert world.session().suspended is True


def test_a_posted_task_wakes_nobody_and_a_conductors_message_wakes_the_coordinator(world: World):
    _suspended_on_an_open_wait(world)
    world.launch(agent_id='coordinator-0', role='coordinator', task_id='coordinate', code=SLEEP)
    _until(world, 1050, 'working', agent_id='coordinator-0')
    # The role's agent waits for its own answer: a posted task must not spend its wake (the row is there to read).
    answer = _deliver(world, _for({'kind': 'role', 'id': 'fixer'}, type='task.posted', task_id='task-9'), 1100)
    assert (answer['woken'], answer['recorded'], world.session().suspended) == ({}, True, True)
    assert set(_deliver(world, _for({'kind': 'conductor', 'id': 'conductor'}), 1101)['woken']) == {'coordinator-0'}


def test_a_message_for_an_agent_not_on_a_wait_gives_it_no_grace(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100)
    assert world.session().woken_at is None


def test_an_addressee_held_without_a_microvm_is_continued_in_a_new_one_to_read_it(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    held = world.store.save(replace(world.session(), status='waiting'))
    answer = _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100)
    continued = world.session()
    assert answer['woken'] == {'fixer-1': 'booting'}
    # Continued for this wait (its grace starts when its harness does).
    assert (continued.continuation, continued.vm_id != held.vm_id, continued.woken_wait) == (1, True, 1100)


def test_an_addressee_another_move_holds_asks_for_a_retry_and_the_row_is_kept(world: World):
    session = _suspended_on_an_open_wait(world)
    world.store.claim(session, 1100, 300)
    raw = _for({'kind': 'agent', 'id': 'fixer-1'})
    with pytest.raises(AddresseeBusy):
        _deliver(world, raw, 1100)
    assert len(_inbox(world)) == 1
    # Lambda's retry, once the claim lapsed: nothing written again, the agent woken.
    assert _deliver(world, raw, 1500) == {'event_id': raw['event_id'], 'recorded': False, 'woken': {'fixer-1': 'working'}}


def test_a_wake_that_fails_is_tried_again(world: World, monkeypatch: pytest.MonkeyPatch):
    _suspended_on_an_open_wait(world)

    def refuse(_vm: Any) -> None:
        raise RuntimeError('the MicroVM did not answer')

    monkeypatch.setattr(world.runtime, 'resume', refuse)
    with pytest.raises(AddresseeBusy):
        _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100)
    monkeypatch.undo()
    assert _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1101)['woken'] == {'fixer-1': 'working'}


def test_a_held_addressee_whose_new_microvm_failed_to_start_is_continued_on_the_retry(
        world: World, monkeypatch: pytest.MonkeyPatch):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    world.store.save(replace(world.session(), status='waiting'))
    raw = _for({'kind': 'agent', 'id': 'fixer-1'})

    def down(_spec: Any) -> Any:
        raise RuntimeError('the MicroVM service refused the start')

    with monkeypatch.context() as patch:
        patch.setattr(world.runtime, 'run', down)
        with pytest.raises(AddresseeBusy):
            _deliver(world, raw, 1100)
    # The failed start spent nothing: the retry continues it for this wait (its once-per-wait mark unused).
    assert _deliver(world, raw, 1101)['woken'] == {'fixer-1': 'booting'}
    assert (world.session().continuation, world.session().crashes) == (1, 0)


def test_a_later_message_does_not_extend_the_wake_nor_the_waits_hold(world: World):
    _suspended_on_an_open_wait(world)
    raw = _for({'kind': 'agent', 'id': 'fixer-1'})
    _deliver(world, raw, 1100)
    _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100 + T.wake_grace - 60)
    assert world.session().woken_at == 1100
    # Messages keep coming, every 9 minutes: the wait's 45 minutes still count from its start.
    now = 1100
    while now < 1001 + T.wait_suspend_limit:
        now += 9 * 60
        _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), now)
        world.supervisor.tick(now)
    assert world.session().status == 'pause_requested'


def test_a_held_agent_is_continued_once_per_wait(world: World):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    world.store.save(replace(world.session(), status='waiting', wait_since=1001))
    _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100)
    continued = world.store.save(replace(world.session(), status='waiting'))
    # The same wait, still open: a second message continues nothing.
    assert _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1200)['woken'] == {'fixer-1': 'waiting'}
    assert world.session().continuation == continued.continuation
    # Nor after a crashed boot continued it again: a continuation keeps the record of the wait it was woken for.
    again = world.session().on(RuntimeSession(vm_id='vm-9', agent_id='fixer-1', endpoint=''), 1250, None)
    assert (again.woken_wait, again.wait_since, again.woken_at) == (1001, 1001, None)


def test_an_agent_continued_by_a_message_reads_it_before_its_long_wait_holds_it_again(world: World):
    # Its wait still open: the new MicroVM boots and works, awake and not asked to pause, for the grace.
    tick = _continued_by_a_message(world)
    for later in range(tick + 60, tick + T.wake_grace, 60):
        world.supervisor.tick(later)
    working = world.session()
    assert (working.status, working.suspended) == ('working', False)
    world.supervisor.tick(tick + T.wake_grace)
    assert world.session().status == 'pause_requested'


def test_a_message_after_a_continued_agents_grace_does_not_open_another(world: World):
    tick = _continued_by_a_message(world)
    # Its grace runs from its harness start, not from the message.
    assert world.session().woken_at == tick
    graced = tick
    # A message just after the grace ends, before the next tick: the hold applies at that tick.
    _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), graced + T.wake_grace + 1)
    assert world.session().woken_at == graced
    world.supervisor.tick(graced + T.wake_grace + 30)
    assert world.session().status == 'pause_requested'


def test_only_the_continuation_a_message_made_gets_the_grace_not_one_after_it(world: World):
    tick = _continued_by_a_message(world)
    # During its grace the agent asks to be continued again (its own pause): that MicroVM gets no grace of its own.
    vm = world.runtime.run(world.session().spec())
    world.store.save(world.session().on(vm, tick, None))
    tick = _working_from(world, tick)
    assert world.session().woken_at is None
    world.supervisor.tick(tick + 60)
    assert world.session().status == 'pause_requested'


@pytest.mark.parametrize('limit', ['budget', 'thirty_days'])
def test_a_run_past_a_limit_records_the_message_and_starts_no_microvm(world: World, limit: str):
    world.launch(code=SLEEP)
    _until(world, 1000, 'working')
    held = world.store.save(replace(world.session(), status='waiting'))
    if limit == 'budget':
        world.control.spend = replace(world.control.spend, tokens=10, max_tokens=10)
        now = 1100
    else:
        now = 30 * 24 * 3600
    assert _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), now)['woken'] == {}
    assert (len(_inbox(world)), world.session().vm_id) == (1, held.vm_id)


def test_a_stopped_run_records_the_message_and_wakes_nobody(world: World):
    _suspended_on_an_open_wait(world)
    world.control.stops.add(RUN)
    assert _deliver(world, _for({'kind': 'agent', 'id': 'fixer-1'}), 1100)['woken'] == {}
    assert (len(_inbox(world)), world.session().suspended) == (1, True)


@pytest.mark.parametrize(('raw', 'seq', 'refused'), [
    ({'schema': 'voc-msg/1'}, 1, 'not a voc-msg/1 message'),
    ('_other_workspace', 1, 'another workspace'),
    ('_to_the_run', 1, 'no inbox'),
    ('_valid', -1, 'seq'),
    ('_valid', True, 'seq'),
    ('_valid', None, 'seq'),
], ids=['malformed', 'other-workspace', 'to-the-run', 'negative-seq', 'bool-seq', 'no-seq'])
def test_a_message_that_has_no_inbox_here_is_refused_and_nothing_written(world: World, raw: Any, seq: Any,
                                                                         refused: str):
    named: dict[str, dict[str, Any]] = {
        '_other_workspace': _for({'kind': 'agent', 'id': 'fixer-1'}, ws='other',
                                 refs={'s3': [f'ws/other/runs/{RUN}/a/b']}),
        '_to_the_run': _for({'kind': 'run', 'id': RUN}, type='run.health'),
        '_valid': _for({'kind': 'agent', 'id': 'fixer-1'})}
    built: dict[str, Any] = named[raw] if isinstance(raw, str) else raw
    with pytest.raises(RuntimeRefused, match=refused):
        _deliver(world, built, 1000, seq=seq)
    assert _inbox(world) == []
