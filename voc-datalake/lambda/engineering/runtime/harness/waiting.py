"""The run coordinator's wait for its agents (7.54.00): ``wait_for_agents``, and the rule its ``finish`` keeps.

The first live run's coordinator posted a step's task and launched its agent, then had no way to wait: it read the
board ("classify running"), ended its turn, was nudged, and called ``finish`` with the run unfinished, which left the
run with no live agent. Now it waits here:

1. It reads the board: the tasks an agent works on (``working``: not ended, its lease's holder or the agent launched
   for it at its attempt, never the coordinator's own task). With none it answers at once, naming any task posted
   with no agent (to launch), and opens no wait.
2. It opens a wait on its lease: a progress report with ``waiting`` (one line, "waiting for 1 task: Understand and
   classify"), so the supervisor holds the session outside its clocks and suspends its microVM (no CPU is used).
3. It polls the session's inbox every ``POLL_SECONDS`` (``AgentContext.waiter``: the Converse loop's
   ``AgentSession.take_messages``; for the CLI and Kiro, the tool server's batches from its harness, which reads the
   inbox and acts on a pause itself) and, every ``CHECK_SECONDS``, renews the lease and reads the board again.
4. It returns at the first news: a message (a task of the run done, failed or needing a person, an agent that stopped
   answering or failed: ``bus/routing.py`` delivers each to the conductor's inbox and wakes the coordinator; a
   question; steering), a waited task that ended or moved on (the board's own word, should a delivery be lost), a
   pause, or ``MAX_WAIT_SECONDS`` without news ("no news yet: read the flow and the board, then wait again").

Before it returns it renews the lease (a session the supervisor suspended missed its heartbeats; the board takes a
renewal while the wait is open, whether or not the lease ran out meanwhile), then closes the wait: a progress report
without ``waiting``, saying what came. A pause closes it only when news came with it, so the continuation is started
at once to read it (the CLI's and Kiro's harness, which acts on a pause itself, closes it so too:
``AgentSession.paused_with``); without news the wait stays open, and a long wait's pause
(``supervisor._follow_wait``) holds the coordinator without a session until a message wakes it. A coordinator's
continuation closes the wait its last session left open, first thing (``main.py``). The messages reach the model as
data in the session's fence (steering in its steering block: ``AgentContext.note``).

Suspended, the session runs nothing: its harness stops in its sleep here, a delivery resumes it
(``Supervisor.wake``, which keeps it awake ``wake_grace`` to read the message) and the next poll takes the message.

**The finish rule** (``finish_refusal``): the coordinator's ``finish`` is refused while an agent still works on a
task of the run (``working``) and the run can go on: its flow is still running (or it follows none) and no task of it
failed twice (ended failed or needing a person at its second attempt or later). The answer names the tasks: "agents
are still working on …: call wait_for_agents". Once the flow has finished or stopped at a person, once a task failed
twice, or once no agent works on anything (the caps refused the next post, say), ``finish`` goes through, as the
skill's "When to stop" asks; so it does in a session with no planner wired (it could launch nothing).
"""
from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Final

from engineering.runtime.harness.board_client import BoardRefused
from engineering.runtime.harness.ports import HarnessPortNotWired, InboxMessage, TaskSummary

#: What tools.py hands in (its ToolResult class, its AgentContext): taken as arguments, as coordinator.py does.
Built = Any

#: The tool's name (coordinator.py's spec; the adapters tell a session that may wait by it).
TOOL: Final = 'wait_for_agents'
#: The progress step a pause with news beside it closes the wait with (the CLI's and Kiro's harness: ``interface.py``).
PAUSED_WITH_NEWS: Final = 'paused with news to read'

#: How often the wait looks at its inbox (the CLI's own inbox poll: cli.INBOX_POLL_SECONDS).
POLL_SECONDS: Final = 5.0
#: How often it renews the lease and reads the board again (the heartbeat's cadence, main.HEARTBEAT_SECONDS).
CHECK_SECONDS: Final = 60.0
#: The longest one wait lasts, awake: well under the supervisor's long-wait hold (``caps.Timings.wait_suspend_limit``,
#: 45 minutes), so a wait the supervisor never suspended ends, and the coordinator looks again, before that hold; and
#: under Kiro's limit on one tool call (``kiro.MCP_TIMEOUT_MS``: a repository command's hour, as long as ``run`` takes).
MAX_WAIT_SECONDS: Final = 25 * 60
NO_NEWS: Final = 'no news yet: read the flow and the board, then wait again'
#: A task's states once it has ended (board/model.py ``FINAL``).
ENDED: Final = frozenset({'done', 'failed', 'needs_human'})
#: A task "failed twice": it ended without being done at this attempt or a later one (its first was re-posted).
FAILED_TWICE_ATTEMPT: Final = 2
#: The flow's outcome while it goes on (flow/conductor.py ``GOING``).
FLOW_RUNNING: Final = 'running'
#: The tasks a refusal or a step line names at most.
MAX_NAMED: Final = 5


@dataclass(frozen=True)
class News:
    """One look at the inbox: its messages, whether a pause was asked, and whether something outside the inbox ended
    the wait (``interrupted``: the Kiro adapter's steering, sent as a prompt and so already in the conversation)."""

    messages: tuple[InboxMessage, ...] = ()
    pause: bool = False
    interrupted: bool = False

    @property
    def came(self) -> bool:
        return bool(self.messages) or self.pause or self.interrupted


#: How a session's tools look at its inbox while they wait (``AgentContext.waiter``).
Waiter = Callable[[], News]


def working(tasks: Sequence[TaskSummary], own_task: str) -> list[TaskSummary]:
    """The tasks an agent works on: not ended, with an agent on it (its lease's holder, or the agent launched for it
    at its attempt), never the coordinator's own."""
    return [task for task in tasks if task.task_id != own_task and task.state not in ENDED and task.agent]


def unlaunched(tasks: Sequence[TaskSummary], own_task: str) -> list[TaskSummary]:
    """The tasks posted with no agent on them (none launched yet, or re-posted since its launch)."""
    return [task for task in tasks if task.task_id != own_task and task.state not in ENDED and not task.agent]


def waiting_line(tasks: Sequence[TaskSummary]) -> str:
    """The wait's progress step: ``waiting for 1 task: <title>`` (``tools.progress_line`` makes it one line)."""
    titles = '; '.join(task.title or task.task_id for task in tasks[:MAX_NAMED])
    more = f'; and {len(tasks) - MAX_NAMED} more' if len(tasks) > MAX_NAMED else ''
    return f'waiting for {len(tasks)} task{"" if len(tasks) == 1 else "s"}: {titles}{more}'


def _named(tasks: Sequence[TaskSummary]) -> str:
    """Task ids and their agents (the board's own ids, never a title: that is data)."""
    named = ', '.join(f'{task.task_id} ({task.agent})' if task.agent else task.task_id for task in tasks[:MAX_NAMED])
    return named + (f' and {len(tasks) - MAX_NAMED} more' if len(tasks) > MAX_NAMED else '')


def _rows(tasks: Sequence[TaskSummary]) -> str:
    return json.dumps([{'task_id': task.task_id, 'role': task.role, 'title': task.title, 'state': task.state,
                        'attempt': task.attempt, 'agent': task.agent or None} for task in tasks])


def moved(waited: Sequence[TaskSummary], now: Sequence[TaskSummary]) -> list[TaskSummary]:
    """The waited tasks the board shows ended or moved on (re-posted, its agent gone), as the board has them now."""
    current = {task.task_id: task for task in now}
    return [current[task.task_id] for task in waited if task.task_id in current and (
        current[task.task_id].state in ENDED or current[task.task_id].attempt != task.attempt
        or current[task.task_id].agent != task.agent)]


def finish_refusal(context: Built) -> str | None:
    """Why the run coordinator may not ``finish`` yet (the module's finish rule), None when it may."""
    try:
        tasks = context.planner.tasks(run_id=context.run_id)
        live = working(tasks, context.task_id)
        if not live or any(task.state in ENDED - {'done'} and task.attempt >= FAILED_TWICE_ATTEMPT
                           for task in tasks if task.task_id != context.task_id):
            return None
        plan = context.planner.flow(run_id=context.run_id)
    except HarnessPortNotWired:
        return None   # (no planner, so nothing was posted or launched to wait for)
    except BoardRefused as refused:
        if refused.status >= 500:
            raise
        return f'finish refused: the board could not be read ({refused}): read the board and try again'
    if isinstance(plan, dict) and plan.get('outcome') != FLOW_RUNNING:
        return None
    return (f'finish refused: agents are still working on {_named(live)}: call wait_for_agents, then read the flow '
            'and the board. Finish once the flow has finished or stopped at a person, or a task failed twice.')


def _renew(context: Built) -> None:
    """Renew the lease; a failed renewal is said on the status, and the next one (or the heartbeat's) tries again."""
    try:
        context.board.heartbeat(run_id=context.run_id, task_id=context.task_id, agent_id=context.agent_id)
    except Exception as error:  # noqa: BLE001 - one failed renewal must not end the wait (main._renew's rule)
        context.status.at(f'the lease was not renewed while waiting ({type(error).__name__})')


def _board_now(context: Built) -> list[TaskSummary] | None:
    """The board, read again while waiting; None when it cannot be read now (the next look tries again)."""
    with contextlib.suppress(Exception):
        return list(context.planner.tasks(run_id=context.run_id))
    return None


def _answer(context: Built, news: News, changed: Sequence[TaskSummary]) -> str:
    """What the model reads when the wait ends (the messages and the board's rows as data, in its fence)."""
    if news.messages:
        count = len(news.messages)
        head = (f'news while you waited ({count} message{"" if count == 1 else "s"}): act on it, then read the flow '
                'and the board.')
        return '\n'.join([head, *(context.note(message) for message in news.messages)])
    if news.interrupted:
        return "the wait ended: a person's steering came, and it is in your conversation: act on it."
    if changed:
        return '\n'.join(['the board changed while you waited: read the flow and the board, then act on it.',
                          context.data('board', _rows(changed))])
    return NO_NEWS


def _closing(news: News, changed: Sequence[TaskSummary]) -> str:
    """The progress step that closes the wait: what came."""
    if news.messages:
        kinds = ', '.join(dict.fromkeys(message.kind for message in news.messages))
        return f'done waiting: {len(news.messages)} message(s) ({kinds})'
    if news.interrupted:
        return "done waiting: a person's steering came"
    if changed:
        return f'done waiting: the board changed ({_named(changed)})'
    return 'done waiting: no news yet'


def _nothing_to_wait_for(context: Built, tasks: Sequence[TaskSummary]) -> str:
    text = ('no agent is working on a task of the run: nothing to wait for. Read the flow: post and launch the next '
            'step\'s tasks, or finish once the flow has finished.')
    idle = unlaunched(tasks, context.task_id)
    if idle:
        text += '\nPosted with no agent on it (launch_agent each one you still need):\n' + context.data(
            'board', _rows(idle))
    return text


def _waited(context: Built, waiter: Waiter, waited: Sequence[TaskSummary]) -> tuple[News, list[TaskSummary]]:
    """Look at the inbox every ``POLL_SECONDS`` (and at the board, renewing the lease, every ``CHECK_SECONDS``)
    until news, a waited task that moved, or ``MAX_WAIT_SECONDS``: what came."""
    started = checked = context.clock()
    while True:
        context.sleep(POLL_SECONDS)
        news = waiter()
        if news.came:
            return news, []
        now = context.clock()
        if now - checked >= CHECK_SECONDS:
            checked = now
            _renew(context)
            board = _board_now(context)
            changed = moved(waited, board) if board is not None else []
            if changed:
                return news, changed
        if now - started >= MAX_WAIT_SECONDS:
            return news, []


def wait_for_agents(context: Built, result: Callable[..., Built]) -> Built:
    """The ``wait_for_agents`` tool (the module's steps)."""
    waiter: Waiter | None = context.waiter
    if waiter is None:
        return result('wait_for_agents refused: this session has no inbox to wait on', error=True)
    news = waiter()
    if news.pause:
        return result('paused: the session saves its checkpoint and stops; its continuation reads the news',
                      paused=True)
    if news.came:
        return result(_answer(context, news, ()))
    tasks = context.planner.tasks(run_id=context.run_id)
    waited = working(tasks, context.task_id)
    if not waited:
        return result(_nothing_to_wait_for(context, tasks))
    context.progress(waiting_line(waited), waiting=True)
    try:
        news, changed = _waited(context, waiter, waited)
    except BoardRefused:
        # (the inbox refused a look: the wait is closed, best effort, before the refusal is answered or raised)
        with contextlib.suppress(Exception):
            context.progress('done waiting: the board refused a look at the inbox', waiting=False)
        raise
    _renew(context)
    if news.pause and not news.messages:
        # (the wait stays open: held without a session until a message wakes it, or as a person's pause holds it)
        return result('paused: the session saves its checkpoint and stops; the wait stays open until news comes',
                      paused=True)
    context.progress(_closing(news, changed), waiting=False)
    if news.pause:
        return result('paused with news: the session saves its checkpoint and stops; its continuation reads it',
                      paused=True)
    return result(_answer(context, news, changed))
