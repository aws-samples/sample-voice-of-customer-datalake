"""The run coordinator waits for its agents (7.54.00, ``harness/waiting.py``): ``wait_for_agents`` opens a wait on its
lease, takes its inbox until news, renews the lease and closes the wait; its ``finish`` is refused while its agents
still work on a run that can go on; and it is nudged to wait, never to finish, when it answers without a tool."""
from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Any

import pytest

from engineering.runtime.harness import waiting
from engineering.runtime.harness.board_client import BoardRefused
from engineering.runtime.harness.converse_loop import COORDINATOR_NUDGE, NUDGE, ConverseAdapter, nudge
from engineering.runtime.harness.ports import InboxMessage, TaskSummary
from engineering.runtime.harness.tool_server import SessionFiles
from engineering.runtime.harness.tool_server import waiter as files_waiter
from engineering.runtime.harness.tools import PROGRESS_MAX
from engineering.runtime.test.harness_fakes import FakeBedrock, FakeBoard, World, opened, use, world
from engineering.runtime.test.test_engineering_coordinator import FakePlanner

#: The one task the coordinator waits for: the understander's, under way.
CLASSIFY = TaskSummary(task_id='task-2', role='understander', title='Understand and classify', state='in_progress',
                       agent='understander-2', step='classify')
DONE = InboxMessage(kind='task.done', summary='Understand and classify (done, by understander-2)', event_id='E-DONE',
                    sender='board')


@dataclass
class LoggedBoard(FakeBoard):
    """The board's lease calls in the order they came: a renewal, or a progress report and whether it waits."""

    log: list[tuple[Any, ...]] = field(default_factory=list)

    def heartbeat(self, *, run_id: str, task_id: str, agent_id: str) -> None:
        super().heartbeat(run_id=run_id, task_id=task_id, agent_id=agent_id)
        self.log.append(('renew',))

    def progress(self, run_id: str, task_id: str, agent_id: str, step: str, *, waiting: bool = False) -> None:
        super().progress(run_id, task_id, agent_id, step, waiting=waiting)
        self.log.append(('progress', step, waiting))


@dataclass
class Clock:
    """The wait's clock and its sleep: each sleep moves the clock on (``hook`` runs at each, with the time)."""

    now: float = 0.0
    sleeps: list[float] = field(default_factory=list)
    hook: Any = None

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds
        if self.hook is not None:
            self.hook(self.now)


def _coordinator(tmp_path: Any, board: list[TaskSummary] | None = None, *queued: list[InboxMessage],
                 plan: dict[str, Any] | None = None) -> tuple[World, FakePlanner, LoggedBoard, Clock]:
    """A coordinator's session whose wait takes its own inbox (the Converse loop's waiter), on a clock of its own."""
    w = world(tmp_path, role='coordinator')
    planner, lease, clock = FakePlanner(board=list([CLASSIFY] if board is None else board), plan=plan), LoggedBoard(), \
        Clock()
    context = w.session.context
    context.planner, context.board, context.clock, context.sleep = planner, lease, clock, clock.sleep
    context.waiter = w.session.news
    w.inbox.queued = [list(batch) for batch in queued]
    return w, planner, lease, clock


def _wait(w: World) -> Any:
    return w.session.tools.call('wait_for_agents', {})


def test_a_tasks_ended_states_are_the_boards():
    # (the harness ships in the images without the board's modules: its own copy, held to the board's here)
    from engineering.board.model import FINAL
    assert waiting.ENDED == FINAL


def test_the_coordinator_has_the_wait_and_no_other_role_does(tmp_path):
    coordinator = world(tmp_path / 'c', role='coordinator').session.tools
    assert 'wait_for_agents' in {spec.name for spec in coordinator.specs}
    fixer = world(tmp_path / 'f').session.tools
    assert fixer.call('wait_for_agents', {}).text == "no tool 'wait_for_agents' for this agent"


def test_a_task_done_while_waiting_ends_the_wait_and_reaches_the_model_as_data(tmp_path):
    w, _, lease, clock = _coordinator(tmp_path, None, [], [], [DONE])
    result = _wait(w)
    fence = w.session.context.fence
    assert (result.error, result.paused) == (False, False)
    assert result.text.startswith('news while you waited (1 message): act on it, then read the flow and the board.')
    assert opened('message:task.done', fence) in result.text
    assert 'by understander-2' in result.text
    # Waiting opened on the lease (its one-line step), then renewed and closed, in that order: a session the
    # supervisor suspended renews while the wait is still open, which the board takes even past the lease's expiry.
    assert lease.log == [('progress', 'waiting for 1 task: Understand and classify', True), ('renew',),
                         ('progress', 'done waiting: 1 message(s) (task.done)', False)]
    assert clock.sleeps == [waiting.POLL_SECONDS, waiting.POLL_SECONDS]
    # Handed with the result: it reached the model once its next turn takes the inbox (``shown``).
    assert [message.event_id for message in w.session.handed] == ['E-DONE']


def test_with_no_news_it_renews_the_lease_each_minute_and_ends_at_its_cap(tmp_path):
    w, planner, lease, clock = _coordinator(tmp_path)
    reads: list[float] = []
    planner_tasks = planner.tasks
    planner.tasks = lambda *, run_id: reads.append(clock.now) or planner_tasks(run_id=run_id)  # type: ignore[method-assign]
    result = _wait(w)
    assert result.text == waiting.NO_NEWS == 'no news yet: read the flow and the board, then wait again'
    assert clock.now == waiting.MAX_WAIT_SECONDS == 25 * 60
    minutes = int(waiting.MAX_WAIT_SECONDS // waiting.CHECK_SECONDS)
    # A renewal and a look at the board each minute (the heartbeat's cadence), and one more renewal before it closes.
    assert lease.log.count(('renew',)) == minutes + 1
    assert reads == [0.0, *(waiting.CHECK_SECONDS * n for n in range(1, minutes + 1))]
    assert lease.log[-1] == ('progress', 'done waiting: no news yet', False)
    assert lease.waiting_seen == [True, False]


def test_a_wait_the_supervisor_suspended_reads_its_news_once_woken_and_renews_before_it_closes(tmp_path):
    # The microVM was suspended in the wait's sleep (40 minutes, past the wait's own cap: the lease ran out
    # meanwhile) and a delivery resumed it for the message: the next look takes the message first, the lease is
    # renewed while the wait is still open (the board takes it then), and only then is the wait closed.
    w, _, lease, clock = _coordinator(tmp_path)

    def suspended(now: float) -> None:
        if now == waiting.POLL_SECONDS:
            clock.now += 40 * 60
            w.inbox.queued.append([DONE])

    clock.hook = suspended
    result = _wait(w)
    assert result.text.startswith('news while you waited (1 message)')
    assert lease.log[-2:] == [('renew',), ('progress', 'done waiting: 1 message(s) (task.done)', False)]


def test_a_waited_task_the_board_shows_ended_ends_the_wait_without_its_message(tmp_path):
    w, planner, lease, clock = _coordinator(tmp_path)
    # Its delivery lost: the board's own word ends the wait at the next look.
    clock.hook = lambda now: setattr(planner, 'board', [replace(CLASSIFY, state='done')]) if now >= 30 else None
    result = _wait(w)
    assert clock.now == waiting.CHECK_SECONDS
    assert result.text.startswith('the board changed while you waited: read the flow and the board, then act on it.')
    assert opened('board', w.session.context.fence) in result.text
    assert '"state": "done"' in result.text
    assert lease.log[-1] == ('progress', 'done waiting: the board changed (task-2 (understander-2))', False)


@pytest.mark.parametrize('moved', [{'attempt': 2, 'agent': ''}, {'agent': 'understander-5'}],
                         ids=['re-posted', 'another-agent'])
def test_a_waited_task_re_posted_or_taken_over_is_news_too(tmp_path, moved: dict[str, Any]):
    w, planner, _, clock = _coordinator(tmp_path)
    clock.hook = lambda _now: setattr(planner, 'board', [replace(CLASSIFY, **moved)])
    assert _wait(w).text.startswith('the board changed while you waited')


def test_steering_while_waiting_comes_in_the_steering_block(tmp_path):
    steer = InboxMessage(kind='msg.steer', summary='keep the public divide signature', event_id='E-S',
                         sender='human:person-1')
    w, _, lease, _ = _coordinator(tmp_path, None, [], [steer])
    result = _wait(w)
    fence = w.session.context.fence
    assert f'<<<STEERING steer:human:person-1 {fence}>>>' in result.text
    assert lease.waiting_seen == [True, False]


def test_news_already_in_the_inbox_is_answered_at_once_and_no_wait_opens(tmp_path):
    w, _, lease, clock = _coordinator(tmp_path, None, [DONE])
    assert _wait(w).text.startswith('news while you waited (1 message)')
    assert (lease.log, clock.sleeps) == ([], [])


def test_with_no_agent_working_there_is_nothing_to_wait_for_and_unlaunched_tasks_are_named(tmp_path):
    posted = TaskSummary(task_id='task-3', role='fixer', title='Fix the cut', state='open')
    ended = replace(CLASSIFY, state='done')
    w, _, lease, clock = _coordinator(tmp_path, [ended, posted])
    text = _wait(w).text
    assert text.startswith('no agent is working on a task of the run: nothing to wait for.')
    assert 'Posted with no agent on it (launch_agent each one you still need):' in text
    assert '"task-3"' in text
    assert (lease.log, clock.sleeps) == ([], [])
    w, _, _, _ = _coordinator(tmp_path / 'empty', [])
    assert 'Posted with no agent' not in _wait(w).text


def test_the_waits_step_is_one_line_naming_its_tasks(tmp_path):
    many = [replace(CLASSIFY, task_id=f'task-{n}', title=f'Shard {n}\nof the map {"x" * 40}') for n in range(2, 9)]
    w, _, lease, _ = _coordinator(tmp_path, many, [], [DONE])
    _wait(w)
    step, opened_wait = lease.log[0][1], lease.log[0][2]
    assert opened_wait is True
    assert step.startswith('waiting for 7 tasks: Shard 2 of the map')
    assert '\n' not in step
    assert len(step) <= PROGRESS_MAX
    assert step.endswith('…')
    assert waiting.waiting_line(many).endswith('; and 2 more')


def test_a_pause_while_waiting_pauses_the_session_and_leaves_the_wait_open(tmp_path):
    pause = InboxMessage(kind='pause', event_id='E-PAUSE')
    # (the loop's own look at its turn's start, the wait's first, then the pause after its first sleep)
    w, _, lease, _ = _coordinator(tmp_path, None, [], [], [pause])
    bedrock = FakeBedrock([[use('wait_for_agents')]])
    assert ConverseAdapter(bedrock, 'model-a').run(w.session) == 'paused'
    # Checkpointed; the wait stays open (no news came), so the supervisor holds it without a session until a message
    # wakes it, and its continuation closes it first (main.py).
    assert any('/_checkpoints/' in key for key in w.store.objects)
    assert lease.log == [('progress', 'waiting for 1 task: Understand and classify', True), ('renew',)]
    assert (w.inbox.finished, len(bedrock.requests)) == (['E-PAUSE'], 1)


def test_a_pause_with_news_closes_the_wait_and_keeps_the_news_for_the_continuation(tmp_path):
    pause = InboxMessage(kind='pause', event_id='E-PAUSE')
    w, _, lease, _ = _coordinator(tmp_path, None, [], [], [DONE, pause])
    assert ConverseAdapter(FakeBedrock([[use('wait_for_agents')]]), 'model-a').run(w.session) == 'paused'
    # Closed, so a long wait's hold continues it at once; the message never reached the model: read again.
    assert lease.waiting_seen == [True, False]
    assert 'E-DONE' not in w.inbox.finished


def test_a_cli_or_kiro_pause_with_news_closes_the_tool_servers_wait_and_only_then(tmp_path):
    # Their harness reads the inbox and acts on a pause itself, ending the tool server mid-wait.
    w, _, lease, _ = _coordinator(tmp_path)
    w.session.paused_with([])
    assert lease.log == []
    w.session.paused_with([DONE])
    assert lease.log == [('progress', waiting.PAUSED_WITH_NEWS, False)]
    fixer = world(tmp_path / 'fixer')
    fixer.session.paused_with([DONE])
    assert fixer.board.progress_seen == []


def test_a_pause_whose_close_is_refused_still_pauses(tmp_path):
    w, _, lease, _ = _coordinator(tmp_path)
    asked: list[object] = []

    def refuse(*args: Any, **_kwargs: Any) -> None:
        asked.append(args)
        raise BoardRefused(503, 'retry')

    lease.progress = refuse  # type: ignore[method-assign]
    w.session.paused_with([DONE])   # (never raising: the pause is the outcome)
    assert len(asked) == 1   # (the wait's close was asked, once, and its refusal swallowed)


def test_an_inbox_that_refuses_a_look_closes_the_wait_first(tmp_path):
    w, _, lease, _ = _coordinator(tmp_path)
    looks = iter([waiting.News()])

    def look() -> waiting.News:
        news = next(looks, None)
        if news is None:
            raise BoardRefused(403, 'the run has another coordinator now')
        return news

    w.session.context.waiter = look
    result = _wait(w)
    assert (result.error, result.text.startswith('the board refused: the board answered 403')) == (True, True)
    assert lease.log[-1] == ('progress', 'done waiting: the board refused a look at the inbox', False)


def test_a_session_without_a_waiter_refuses_the_wait(tmp_path):
    w, _, lease, _ = _coordinator(tmp_path)
    w.session.context.waiter = None
    result = _wait(w)
    assert (result.error, result.text) == (True, 'wait_for_agents refused: this session has no inbox to wait on')
    assert lease.log == []


def test_a_board_refusal_to_open_the_wait_is_a_result_the_model_reads(tmp_path):
    w, _, lease, _ = _coordinator(tmp_path)

    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise BoardRefused(409, 'the lease is not yours, has run out, or the task has ended')

    lease.progress = refuse  # type: ignore[method-assign]
    result = _wait(w)
    assert (result.error, result.text.startswith('the board refused: the board answered 409')) == (True, True)


# -- the tool server's wait (the CLI's and Kiro's) ----------------------------------------------------------------


def test_the_tool_servers_wait_takes_its_harnesss_batches_and_a_kiro_wake(tmp_path):
    files = SessionFiles(str(tmp_path / 'session'))
    w, _, lease, clock = _coordinator(tmp_path)
    w.session.context.waiter = files_waiter(files)
    # The harness leaves the inbox's message as a batch while the server waits; never a pause (it ends the server).
    clock.hook = lambda _now: files.post([{'kind': 'task.done', 'summary': DONE.summary, 'sender': 'board'}])
    assert _wait(w).text.startswith('news while you waited (1 message)')
    assert files.take_messages() == []
    # Kiro sends steering as a prompt: its wake ends a wait under way, once.
    clock.hook = lambda _now: files.wake()
    assert _wait(w).text == "the wait ended: a person's steering came, and it is in your conversation: act on it."
    assert (files.woken(), lease.log[-1]) == (False, ('progress', "done waiting: a person's steering came", False))
    assert not [name for name in os.listdir(files.directory) if name.startswith('wake-')]


# -- the finish rule -----------------------------------------------------------------------------------------------

RUNNING = {'outcome': 'running', 'steps': []}


def _finish(w: World) -> Any:
    return w.session.tools.call('finish', {'summary': 'The run is not complete: it is stuck at the first step.'})


@pytest.mark.parametrize('plan', [RUNNING, None], ids=['flow-running', 'no-flow'])
def test_finish_is_refused_while_an_agent_works_on_a_run_that_can_go_on(tmp_path, plan: dict[str, Any] | None):
    w, _, lease, _ = _coordinator(tmp_path, [CLASSIFY], plan=plan)
    result = _finish(w)
    assert result.error
    assert result.finished is None
    assert not w.session.context.finished
    assert result.text.startswith('finish refused: agents are still working on task-2 (understander-2): call '
                                  'wait_for_agents, then read the flow and the board.')
    assert (lease.moves, lease.log) == ([], [])


@pytest.mark.parametrize(('board', 'plan'), [
    ([CLASSIFY], {'outcome': 'finished', 'steps': []}),
    ([CLASSIFY], {'outcome': 'needs_human', 'steps': []}),
    ([CLASSIFY, TaskSummary('task-4', 'fixer', 'Fix', 'failed', attempt=2, agent='fixer-5')], RUNNING),
    ([CLASSIFY, TaskSummary('task-4', 'fixer', 'Fix', 'needs_human', attempt=3, agent='fixer-6')], RUNNING),
    ([replace(CLASSIFY, state='done'), TaskSummary('task-3', 'fixer', 'Fix', 'open')], RUNNING),
    ([], RUNNING),
], ids=['flow-finished', 'flow-at-a-person', 'failed-twice', 'needs-a-person-at-its-third', 'none-working',
        'empty-board'])
def test_finish_goes_through_once_the_run_cannot_go_on_or_nobody_works(tmp_path, board: list[TaskSummary],
                                                                       plan: dict[str, Any]):
    w, _, lease, _ = _coordinator(tmp_path, board, plan=plan)
    assert _finish(w).finished is not None
    assert lease.moves[-1][2] == 'done'


def test_a_task_that_failed_once_is_no_reason_to_finish(tmp_path):
    once = TaskSummary('task-4', 'fixer', 'Fix', 'failed', attempt=1, agent='fixer-5')
    w, _, _, _ = _coordinator(tmp_path, [CLASSIFY, once], plan=RUNNING)
    assert _finish(w).error


def test_the_finish_rule_is_the_coordinators_only(tmp_path):
    # A fixer's finish asks no planner (none is wired: a call would refuse).
    w = world(tmp_path)
    assert w.session.tools.call('finish', {'summary': 'fixed'}).finished == 'fixed'


@pytest.mark.parametrize(('status', 'raised'), [(409, False), (503, True)])
def test_a_board_that_cannot_be_read_holds_the_finish_or_crashes(tmp_path, status: int, raised: bool):
    w, planner, _, _ = _coordinator(tmp_path)

    def refuse(*, run_id: str) -> list[TaskSummary]:
        raise BoardRefused(status, f'no board for {run_id}')

    planner.tasks = refuse  # type: ignore[method-assign]
    if raised:
        with pytest.raises(BoardRefused):
            _finish(w)
        return
    assert _finish(w).text.startswith('finish refused: the board could not be read')


# -- the nudge -----------------------------------------------------------------------------------------------------


def test_the_coordinator_is_nudged_to_wait_while_agents_work_every_other_role_as_before(tmp_path):
    assert (nudge('coordinator'), nudge('fixer')) == (COORDINATOR_NUDGE, NUDGE)
    assert COORDINATOR_NUDGE == ('Continue with your tools: if agents are working, call wait_for_agents; when the flow '
                                 'has finished, call finish.')
    w, _, _, _ = _coordinator(tmp_path)
    bedrock = FakeBedrock([[{'text': 'The board says classify is running.'}]])
    ConverseAdapter(bedrock, 'model-a').run(w.session)
    assert {'role': 'user', 'content': [{'text': COORDINATOR_NUDGE}]} in bedrock.requests[-1]['messages']
    fixer = world(tmp_path / 'fixer')
    bedrock = FakeBedrock([[{'text': 'done, I think'}]])
    ConverseAdapter(bedrock, 'model-a').run(fixer.session)
    assert {'role': 'user', 'content': [{'text': NUDGE}]} in bedrock.requests[-1]['messages']


def test_the_converse_loop_wires_the_wait_to_its_own_inbox(tmp_path):
    w, _, lease, _ = _coordinator(tmp_path, None, [], [], [], [DONE])
    w.session.context.waiter = None
    bedrock = FakeBedrock([[use('wait_for_agents')]])
    ConverseAdapter(bedrock, 'model-a').run(w.session)
    texts = [block['toolResult']['content'][0]['text'] for message in bedrock.requests[1]['messages']
             for block in message['content'] if 'toolResult' in block]
    assert texts[0].startswith('news while you waited (1 message)')
    assert lease.waiting_seen == [True, False]
