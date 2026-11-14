"""The supervisor: every minute while any run is active, it keeps each agent's session honest.

For every live session it first claims the session's row (a conditional write), so a tick and a run monitor
signal never move one agent at once; then it renews the agent's role session through the launcher (refused
for a stopped run), boots the checkout and the agent's harness, and while the harness runs it reads the
task's lease and the session's age (``liveness.judge``): it asks a quiet agent for its state, stops one that
does not answer and re-posts its task, asks an agent to pause ahead of the 8-hour limit and continues it in
a new session once it has checkpointed, continues a crashed one from its last checkpoint (twice in a row at
most), and ends a finished one's session at once. A session whose calls fail three ticks in a row, or whose
boot takes over 30 minutes, has crashed. It records the run monitor's inspection data and the live cost
counters on the session row.

Each agent's session is an AgentCore Runtime session (``agentcore.py``): each session is its own microVM.
An agent on an open wait (its lease says so) keeps its task and is outside every clock: its session is
held (its harness stopped where it is, using no CPU), and a wait still open after 45 minutes (the runtime's idle
timeout would end a held session at 60) is checkpointed and held without a session (``waiting``) until the wait
closes, then continued.

Per run it honours a stop (a person's, an agent's kill switch, or the 30-day stop, which also opens a human
decision point offering only "stop"): every session is ended at once without waiting for the agents, and the
launcher renews none of their sessions. A spent budget opens a human decision point and holds every agent
(checkpointed, without a session) for a person to resume; no new session starts while it is spent. It emits
``run.health``, and after each run's moves its flow's budget alert, when the flow's month passed a level of its
monthly budget (``run.budget_alert``: measured, never a stop). It never switches its own schedule: the handler does, around the runs (``handler.start_run``, and its settling
after an ``end_run`` and after each tick).

``signal`` is the server side of the run monitor's controls: Save (checkpoint now), Pause (checkpoint, then
held for a person), Resume (a held agent continued from its checkpoint; refused for a stopped run or a spent
budget), Shut down (checkpoint, then stopped; stopped anyway when no checkpoint comes) and Stop now (ended at
once).
"""
from __future__ import annotations

import contextlib
from collections import Counter
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Final

from engineering.runtime.caps import SESSION_LIFE_SECONDS, Timings
from engineering.runtime.checkout import checkout_commands
from engineering.runtime.checkpoints import CheckpointReader
from engineering.runtime.interface import (
    AgentRuntime,
    CacheMount,
    Command,
    ExecResult,
    RuntimeRefused,
    RuntimeSession,
    SessionsFull,
)
from engineering.runtime.launcher import RENEW_MARGIN_SECONDS, Launcher
from engineering.runtime.liveness import ended, judge
from engineering.runtime.ports import Board, Bus, Lease, RunControl
from engineering.runtime.sessions import (
    LIVE_STATUSES,
    WITH_SESSION,
    After,
    AgentSession,
    LostSession,
    SessionStore,
    StaleSession,
    Status,
)
from shared.logging import logger

THIRTY_DAYS: Final = 30 * 24 * 60 * 60
SIGNALS: Final = frozenset({'save', 'pause', 'resume', 'shutdown', 'stop_now'})
#: Where a held agent goes once it has paused (or crashed while a pause was asked of it).
HELD_AS: Final[dict[After, Status]] = {'hold': 'paused', 'wait': 'waiting', 'shutdown': 'stopped'}
#: How long one move may hold a session's claim: the function's own timeout (lib/stacks/engineering-runtime.ts).
CLAIM_SECONDS: Final = 5 * 60
#: How long after a run's start its coordinator may still be on its way: the runtime's own limit (the 5 minutes of the
#: ``launch_coordinator`` invocation a start hands on) plus a minute's margin. Past it, a run with no coordinator
#: session and no live launch hold of one goes to a person.
COORDINATOR_LAUNCH_SECONDS: Final = CLAIM_SECONDS + 60


class SessionCallFailed(RuntimeError):
    """A call to an agent's session failed (only these count towards a crash; a port's failure does not)."""


def landed_session(sessions: SessionStore, run_id: str, agent_id: str, vm: RuntimeSession) -> AgentSession | None:
    """The agent's row when a write whose answer failed landed after all and names ``vm`` (read back, consistent);
    None when it did not, or the read fails too (then the session is treated as one no row names)."""
    try:
        current = sessions.get(run_id, agent_id)
    except Exception:
        logger.exception('engineering supervisor: a session row could not be read back',
                         extra={'run_id': run_id, 'agent_id': agent_id, 'vm_id': vm.vm_id})
        return None
    return current if current is not None and current.vm_id == vm.vm_id else None


def stop_or_keep_lost(runtime: AgentRuntime, sessions: SessionStore, run_id: str, agent_id: str, role: str,
                      vm: RuntimeSession, now: int) -> None:
    """Stop a session no row names; when the stop fails, log its id and keep it on a row of its own
    (``SessionStore.record_lost``) that every tick stops again and counts. When that record fails too, the session is
    only logged (its id) and its runtime's idle timeout ends it. Never raises: the caller's own failure is what it
    raises."""
    try:
        runtime.terminate(vm)
    except Exception:
        logger.exception('engineering supervisor: a session no row names could not be stopped: kept to stop again',
                         extra={'run_id': run_id, 'agent_id': agent_id, 'vm_id': vm.vm_id})
        try:
            sessions.record_lost(run_id, agent_id, role, vm, now)
        except Exception:
            logger.exception('engineering supervisor: a lost session could not be recorded',
                             extra={'run_id': run_id, 'agent_id': agent_id, 'vm_id': vm.vm_id})


class SessionBusy(RuntimeRefused):
    """Another move holds the session's claim: a signal answers ``busy`` (try again), a tick skips it."""

#: The session's end for each state its task can end in on the board.
ENDED_AS: Final[dict[str, Status]] = {'done': 'done', 'failed': 'failed', 'needs_human': 'failed'}

@dataclass
class Supervisor:
    runtime: AgentRuntime
    sessions: SessionStore
    board: Board
    bus: Bus
    control: RunControl
    launcher: Launcher
    checkpoints: CheckpointReader
    #: The raw bucket: the connections' caches are mounted from it.
    bucket: str
    #: The workspace bucket (voc-eng-workspace): the agents' checkpoints, patches and findings.
    workspace_bucket: str
    timings: Timings = field(default_factory=Timings)
    #: The board API's function URL, handed to every agent (a continuation's too; its host is on the session's egress).
    board_url: str = ''
    #: The connector broker's function URL, handed to every agent likewise (its host on the agent's own proxy only).
    broker_url: str = ''
    #: The checkout an agent boots with (``checkout.checkout_commands``; the tests give a local one).
    checkout: Callable[[str, Sequence[str]], list[Command]] = field(default_factory=lambda: checkout_commands)
    #: Runs whose agents are held, as of their last tick (a spent budget, or the flow waiting at a person): no new
    #: session starts for them.
    _held: set[str] = field(default_factory=set, init=False, repr=False)

    def tick(self, now: int) -> dict[str, int]:
        """One pass over every live session; the number of sessions in each status afterwards."""
        by_run: dict[str, list[AgentSession]] = {}
        for run_id, every, holds in self.sessions.watched_with_holds():
            # (a session whose stop failed too: every tick stops it again)
            live = [session for session in every if session.status in LIVE_STATUSES or session.stop_pending]
            if live:
                by_run[run_id] = live
            try:
                self._retry_lost(run_id, now)
            except Exception:
                logger.exception('engineering supervisor: a run\'s lost sessions could not be stopped',
                                 extra={'run_id': run_id})
            try:
                self._coordinator_lost(run_id, every, now)
                self._coordinator_never_launched(run_id, every, holds, now)
            except Exception:
                logger.exception('engineering supervisor: a run\'s coordinator could not be checked',
                                 extra={'run_id': run_id})
        statuses: Counter[str] = Counter()
        for run_id, run_sessions in by_run.items():
            try:
                statuses.update(self._run(run_id, run_sessions, now))
            except Exception:
                # One run's failing control or bus call must not keep the supervisor from every later run.
                logger.exception('engineering supervisor: a run could not be checked', extra={'run_id': run_id})
                statuses.update(session.status for session in run_sessions)
        return dict(statuses)

    def _coordinator_lost(self, run_id: str, sessions: list[AgentSession], now: int) -> None:
        """Ask for a person again when the run's newest coordinator failed and the run is still active: the session
        was ended as failed but sending the run to a person did not land (``_crashed``), and nothing else would ask.
        Only from the sessions the tick read already, and one read of the coordinate task's lease when its newest
        coordinator failed: none while another coordinator is live or moving, nor once a Resume re-posted the task
        for a new one (its attempt moved on; that one may still be booting)."""
        coordinators = [session for session in sessions if session.role == 'coordinator']
        if not coordinators or any(session.status in LIVE_STATUSES or (session.claimed_until or 0) >= now
                                   for session in coordinators):
            return
        newest = max(coordinators, key=lambda session: (session.task_attempt, session.started_at))
        if newest.status != 'failed':
            return   # (done, or a person's Shut down or Stop now: never replaced, the run stays theirs)
        lease = self.board.lease(run_id, newest.task_id)
        if lease is None or lease.attempt != newest.task_attempt or lease.final_state:
            return
        if self.control.is_active(run_id):
            self.control.needs_human(run_id, 'coordinator')

    def _coordinator_never_launched(self, run_id: str, sessions: list[AgentSession], holds: dict[str, int],
                                    now: int) -> None:
        """Send the run to a person when its start recorded a coordinator that never got a session: the start function
        wrote the run and handed the launch on (``handler.launch_coordinator``), and that invocation crashed or timed
        out before it could send the run to a person itself. Only an active run with no coordinator session and no live
        launch hold of one (from the rows the tick read already), and only ``COORDINATOR_LAUNCH_SECONDS`` after its
        start or its last Resume, whichever is later (a person's Resume launches a new coordinator: it gets its own
        window, and its launch hold covers the launch); then one read of the run's row. Asked once: the run is no longer active after, and a decision point it
        waits at already changes nothing."""
        if any(session.role == 'coordinator' for session in sessions):
            return   # (it has one, live or not: _coordinator_lost's, or a person's to replace)
        if any(agent.startswith('coordinator-') and until >= now for agent, until in holds.items()):
            return   # (a launch of it is under way)
        started = self.control.coordinator_awaited(run_id)
        if started is not None and now - started > COORDINATOR_LAUNCH_SECONDS:
            logger.warning('engineering supervisor: a run\'s coordinator was never launched', extra={'run_id': run_id})
            self.control.needs_human(run_id, 'coordinator')

    def _stopping(self, run_id: str, now: int) -> bool:
        # An ended run first: it is past any decision point, the 30-day one included.
        if self.control.stop_requested(run_id):
            return True
        if now - self.control.started_at(run_id) >= THIRTY_DAYS:
            self.control.needs_human(run_id, 'thirty_days')
            return True
        return False

    def _run(self, run_id: str, run_sessions: list[AgentSession], now: int) -> list[str]:
        if self._stopping(run_id, now):
            results = [self._ticked(session, now, lambda s: self._end(s, 'stopped', now)) for session in run_sessions]
            self.bus.emit(run_id, 'run', 'run.health', f'Stopped: {len(results)} session(s) ended.')
            self._budget_alert(run_id, now)   # (its agents' last writes may have passed a level)
            return [session.status for session in results]
        budget = self.control.budget(run_id)
        if budget.exceeded:
            self._held.add(run_id)
            self.control.needs_human(run_id, 'budget')
        elif self._flow_point(run_id):
            self._held.add(run_id)   # (held like a spent budget: a person's Resume, their decision, continues them)
        else:
            self._held.discard(run_id)
        results = [self._ticked(session, now, lambda s: self._advance(s, now)) for session in run_sessions]
        # After the moves: a level passed by this tick's writes (an agent's last, too) is said now, even if no agent of
        # the run is live by the next tick.
        self._budget_alert(run_id, now)
        counts = Counter(session.status for session in results)
        self.bus.emit(run_id, 'run', 'run.health',
                      ', '.join(f'{count} {status}' for status, count in sorted(counts.items())),
                      {'tokens': str(budget.tokens), 'cost_usd': f'{budget.cost_usd:.2f}'})
        return [session.status for session in results]

    def _flow_point(self, run_id: str) -> bool:
        """An active run whose flow waits at a person (a human decision point reached, a step blocked, or one the
        runtime cannot do and the flow cannot go on without) goes to that decision point, ``flow:<step>``, before its
        agents move, and they are held (checkpointed, then paused) as for a spent budget: True. A failed read is
        logged and the run goes on (the next tick reads it again)."""
        try:
            stop = self.control.flow_stop(run_id)
        except Exception:
            logger.exception('engineering supervisor: a run\'s flow could not be read', extra={'run_id': run_id})
            return False
        if stop is None:
            return False
        if not stop.waiting:   # (waiting there already: nothing to ask again, its agents stay held)
            logger.info('engineering supervisor: a run\'s flow waits at a person',
                        extra={'run_id': run_id, 'decision_point': stop.point})
            self.control.needs_human(run_id, stop.point)
        return True

    def _budget_alert(self, run_id: str, now: int) -> None:
        """The run's flow passed a level of its monthly budget: said to the run, at least once per flow, budget, level
        and month, from the supervisor's own source. A failed read or write is logged and the run goes on; a send
        that fails gives the claim back for any live run of the flow's next tick (this run may have none). A run being
        wound down (stopping) is checked too, for its agents' last writes: it may be the one that says a level
        another run of the flow passed."""
        try:
            alert = self.control.budget_alert(run_id, now)
        except Exception:
            logger.exception('engineering supervisor: the flow\'s budget could not be checked', extra={'run_id': run_id})
            return
        if alert is None:
            return
        try:
            self.bus.emit(run_id, 'run', 'run.budget_alert', alert.summary())
        except Exception:
            logger.exception('engineering supervisor: the flow\'s budget alert was not sent', extra={'run_id': run_id})
            with contextlib.suppress(Exception):   # (best effort: else it is taken over past the claim's time)
                self.control.alert_not_sent(run_id, alert)
            return
        try:
            self.control.alert_sent(run_id, alert, now)
        except Exception:
            logger.exception('engineering supervisor: a sent budget alert was not closed', extra={'run_id': run_id})

    def _guarded(self, session: AgentSession, now: int, move: Callable[[AgentSession], AgentSession]) -> AgentSession:
        """``move`` on the session, claimed for this move only (a claim someone else holds leaves it to them).

        A failing session call is counted, and the third in a row is a crash (the session is gone or never came
        up); any other failure (the board, the bus, the launcher) is logged and the session left for the next tick.
        """
        try:
            claimed = self.sessions.claim(session, now, CLAIM_SECONDS)
        except StaleSession as busy:
            raise SessionBusy(session.agent_id) from busy
        try:
            return self._release(move(claimed))
        except StaleSession:
            # The move's write was refused. When the row is still as this move last left it (the refusal was a
            # transaction conflict that outlasted its tries, say on a flow's shared month total), the claim is given
            # back, so the next tick moves the agent rather than waiting out the claim; a row someone else moved is
            # theirs, and the release is refused too.
            with contextlib.suppress(Exception):
                return self._release(self._latest(claimed))
            return claimed
        except SessionCallFailed:
            logger.exception('engineering supervisor: a session call failed',
                             extra={'run_id': session.run_id, 'agent_id': session.agent_id})
            return self._failed(self._latest(claimed), now)
        except Exception:
            # One agent's failing move must not stop the supervisor for every other agent.
            logger.exception('engineering supervisor: a session could not move',
                             extra={'run_id': session.run_id, 'agent_id': session.agent_id})
            with contextlib.suppress(Exception):
                return self._release(self._latest(claimed))
            return claimed

    def _latest(self, claimed: AgentSession) -> AgentSession:
        """The row as this move last wrote it (a move may save before it fails), while the claim is still ours."""
        current = self.sessions.get(claimed.run_id, claimed.agent_id)
        return current if current is not None and current.claimed_until == claimed.claimed_until else claimed

    def _release(self, session: AgentSession) -> AgentSession:
        return self._save(replace(session, claimed_until=None)) if session.claimed_until is not None else session

    def _ticked(self, session: AgentSession, now: int, move: Callable[[AgentSession], AgentSession]) -> AgentSession:
        """``move`` for the tick: a session another move holds is left to it until the next tick."""
        try:
            return self._guarded(session, now, move)
        except SessionBusy:
            return session

    def _failed(self, session: AgentSession, now: int) -> AgentSession:
        failed = replace(session, failures=session.failures + 1)
        try:
            if failed.failures >= self.timings.max_runtime_failures and failed.status in WITH_SESSION:
                gone = {**failed.inspect, 'last_failure': 'the session stopped answering'}
                return self._release(self._crashed(replace(failed, failures=0, inspect=gone), now))
            return self._release(failed)
        except Exception:
            logger.exception('engineering supervisor: a failing session could not be recorded',
                             extra={'run_id': session.run_id, 'agent_id': session.agent_id})
            # The count is kept and the claim let go, so the next tick (or a person's Stop now) is not held off.
            with contextlib.suppress(Exception):
                latest = self._latest(failed)
                # A session continued meanwhile starts its own count.
                kept = failed.failures if latest.vm_id == failed.vm_id else latest.failures
                return self._release(replace(latest, failures=kept))
            return failed

    @staticmethod
    def _vm_call[R](call: Callable[[], R]) -> R:
        """``call()`` on an agent's session; its failure is a ``SessionCallFailed`` (it counts towards a crash)."""
        try:
            return call()
        except Exception as error:
            raise SessionCallFailed(f'{type(error).__name__}: {error}'[:300]) from error

    # --- one tick of one agent ------------------------------------------------------------------

    def _emit(self, session: AgentSession, to: str, kind: str, summary: str,
              refs: dict[str, str] | None = None) -> None:
        """One event about ``session`` (its task and attempt)."""
        self.bus.emit(session.run_id, to, kind, summary, refs, task_id=session.task_id, attempt=session.task_attempt)

    def _lease(self, session: AgentSession) -> Lease | None:
        """The task's lease, as the board has it."""
        return self.board.lease(session.run_id, session.task_id)

    @staticmethod
    def _superseded(session: AgentSession, lease: Lease) -> bool:
        """The session's task has moved on: at another attempt (re-posted, claimed or not), or held by another
        agent."""
        return lease.attempt != session.task_attempt or (bool(lease.agent_id) and lease.agent_id != session.agent_id)

    def _refreshed(self, session: AgentSession) -> bool:
        """The holder's lease runs its full time from now (it may have run out on a long hold or a boot)."""
        return self.board.refresh(session.run_id, session.task_id, agent_id=session.agent_id,
                                  attempt=session.task_attempt)

    def _refused(self, session: AgentSession, now: int) -> AgentSession:
        """A refresh refused: the task moved on (another attempt or holder), or ended meanwhile (the session ends as it
        did)."""
        return self._gone(session, self._lease(session), now) or self._end(session, 'reposted', now)

    def _gone(self, session: AgentSession, lease: Lease | None, now: int) -> AgentSession | None:
        """The session's end when its task moved on (another attempt or holder) or ended, else None."""
        if lease is not None and self._superseded(session, lease):
            return self._end_superseded(session, lease, now)
        if lease is not None and lease.ended:
            return self._end(session, ENDED_AS.get(lease.final_state, 'failed'), now)
        return None

    def _end_superseded(self, session: AgentSession, lease: Lease, now: int) -> AgentSession:
        """End a session whose task moved on: never continued nor re-posted."""
        if not lease.agent_id and lease.attempt == session.task_attempt + 1:
            # Open at the next attempt: its own re-post landed but its event may not have (a failed publish), or a
            # person gave the task back. The board's repost_task answers it as it is and publishes the same event
            # again only while the task's last change is the supervisor's own re-post; after a person's release
            # (published as that person) nothing. Then the session ends.
            self.board.repost(session.run_id, session.task_id, 'reposted', attempt=session.task_attempt)
        return self._end(session, 'reposted', now)

    def _advance(self, session: AgentSession, now: int) -> AgentSession:
        if session.stop_pending:
            return self._retry_stop(session, now)
        lease = self._lease(session)
        if lease is not None and self._superseded(session, lease):
            return self._end_superseded(session, lease, now)
        if session.status == 'booting' and lease is not None and not lease.agent_id and lease.ended:
            # Ended with no holder while its agent still boots (a person blocked the open task before its claim):
            # ended at once, never left to boot and then be refused its claim. (A working harness exits on its own
            # once it reads its task ended, so it is left to.)
            return self._end(session, ENDED_AS.get(lease.final_state, 'failed'), now)
        if lease is not None and not lease.agent_id:
            # Open at its own attempt: not claimed yet. Its harness claims it first thing, so the claim is due within
            # the crash clock from the harness's start (a slow first call is no crash); before that, no lease.
            lease = (replace(lease, agent_id=session.agent_id, renewed_at=session.harness_at,
                             last_progress_at=session.harness_at) if session.harness_at is not None else None)
        if session.status == 'waiting' and lease is not None and lease.ended:
            return self._end(session, ENDED_AS.get(lease.final_state, 'failed'), now)
        if session.status == 'waiting':
            return session if lease is not None and lease.waiting else self._continue(session, now, crashed=False)
        if session.run_id in self._held and session.after_pause not in ('hold', 'shutdown'):
            return self._hold(session, now)
        session = self._follow_wait(session, lease, now)
        if not session.suspended:
            session = self._renew(session, now)
        if session.status == 'booting':
            if lease is not None and lease.ended:
                return self._end(session, ENDED_AS.get(lease.final_state, 'failed'), now)
            moved = self._boot(session, now, lease)
        else:
            moved = self._work(session, lease, now)
        return self._observe(moved, lease, now) if moved.status in WITH_SESSION else moved

    def _hold(self, session: AgentSession, now: int) -> AgentSession:
        """A spent budget: a working agent checkpoints and is held; one still booting is held at once."""
        if session.status == 'working':
            self._emit(session, session.agent_id, 'pause', 'The run reached its budget: checkpoint and pause.')
            return self._ask_pause(self._wake(session), now, 'hold')
        if session.status == 'booting':
            return self._end(session, 'paused', now)
        return self._save(replace(session, after_pause='hold'))

    def _follow_wait(self, session: AgentSession, lease: Lease | None, now: int) -> AgentSession:
        """Suspend a working agent's session on an open wait; hold it without one past 45 minutes (or once its
        session nears its 8-hour limit); wake it after."""
        waiting = lease is not None and lease.waiting
        if not waiting:
            woken = self._wake(session)
            return woken if woken.wait_since is None else replace(woken, wait_since=None)
        if session.status != 'working':
            return session
        if session.wait_since is None:
            session = replace(session, wait_since=now)
        # A message woke it: it reads the message before it is suspended again.
        in_grace = session.woken_at is not None and now - session.woken_at < self.timings.wake_grace
        # The wait's own clock, whether its session is suspended or a message keeps it awake. Only the one
        # continuation a message makes per wait (``woken_wait``) reads its message before the clock holds it again:
        # a resumed agent's grace never stops the clock, so no stream of messages keeps a session running.
        continued_for_it = in_grace and self._continued_for_a_message(session)
        long_wait = not continued_for_it and now - (session.wait_since or now) >= self.timings.wait_suspend_limit
        if long_wait or now - session.started_at >= self.timings.pause_after:
            self._emit(session, session.agent_id, 'pause', 'Your wait is long: checkpoint and pause.')
            return replace(self._wake(session), status='pause_requested', pause_requested_at=now, after_pause='wait')
        if not session.suspended:
            if in_grace:
                # Its harness reads the message (and closes the wait) before it is suspended again.
                return session
            self._vm_call(lambda: self.runtime.suspend(session.vm))
            return replace(session, suspended=True)
        return session

    @staticmethod
    def _continued_for_a_message(session: AgentSession) -> bool:
        """This session is the one continuation a message made for the agent's current wait (not one after it)."""
        return (session.woken_wait is not None and session.woken_wait == session.wait_since
                and session.woken_continuation == session.continuation)

    def _wake(self, session: AgentSession) -> AgentSession:
        if not session.suspended:
            return session
        self._vm_call(lambda: self.runtime.resume(session.vm))
        return replace(session, suspended=False)

    def _renew(self, session: AgentSession, now: int) -> AgentSession:
        """Hand the session a fresh role session when it has none or its session lapses within 6 minutes."""
        if session.session_expires_at is not None and session.session_expires_at - now > RENEW_MARGIN_SECONDS:
            return session
        role_session = self.launcher.session_for(
            role=session.role, connection=session.connection, run_id=session.run_id, agent_id=session.agent_id,
            stopped=self.control.stop_requested(session.run_id))
        mount = CacheMount(bucket=self.bucket, connection=session.connection)
        self._vm_call(lambda: self.runtime.hand_session(session.vm, role_session, mount))
        return replace(session, session_expires_at=int(role_session.expires_at))

    def _observe(self, session: AgentSession, lease: Lease | None, now: int) -> AgentSession:
        """The live cost counters and the run monitor's inspection data, on the session row."""
        status = (None if session.suspended or session.status != 'working'
                  else self._vm_call(lambda: self.runtime.status(session.vm)))
        last_progress = int(lease.last_progress_at) if lease is not None else None
        inspect = {
            **session.inspect,
            'step': status.step if status else session.inspect.get('step', ''),
            'recent_tools': list(status.recent_tools) if status else session.inspect.get('recent_tools', []),
            'last_progress_at': last_progress,
            'heartbeat_age': None if lease is None else int(now - lease.renewed_at),
            'microvm_state': 'suspended (open wait)' if session.suspended else 'running',
            'microvm_age': now - session.started_at,
            'stuck_why': (f'no progress for {(now - last_progress) // 60} minutes'
                          if session.asked_at is not None and last_progress is not None else ''),
        }
        return self._save(replace(session, inspect=inspect,
                                  tokens=session.reported(status.tokens) if status else session.tokens,
                                  **self._counted(session, now), last_tick_at=now, failures=0))

    def _boot_commands(self, session: AgentSession) -> list[Command]:
        harness = Command(argv=session.harness, timeout_seconds=SESSION_LIFE_SECONDS, repository_code=False,
                          network=True)
        return [*self.checkout(session.commit, session.paths), harness]

    def _boot(self, session: AgentSession, now: int, lease: Lease | None = None) -> AgentSession:
        if now - session.started_at >= self.timings.boot_deadline:
            return self._crashed(replace(session, inspect={**session.inspect, 'last_failure': 'the boot took too long'}),
                                 now)
        commands = self._boot_commands(session)
        vm, running = session.vm, session.exec_id
        if running is not None:
            result = self._vm_call(lambda: self.runtime.poll_exec(vm, running))
            if result is None:
                return session
            if not result.ok:
                return self._crashed(self._with_exit(session, result), now)
            session = replace(session, boot_index=session.boot_index + 1, exec_id=None)
        command = commands[session.boot_index]
        last = session.boot_index == len(commands) - 1
        if last and lease is not None and lease.agent_id and not self._refreshed(session):
            # Its harness starts on a lease of its own (a continuation's ran out over the boot's minutes): refused, the
            # task is not this agent's at this attempt any more.
            return self._refused(session, now)
        exec_id = self._vm_call(lambda: self.runtime.start_exec(vm, command))
        if last and self._continued_for_a_message(session):
            # The continuation a message made for this wait: its grace to read the message starts with its harness.
            session = replace(session, woken_at=now)
        return self._save(replace(session, exec_id=exec_id, status='working' if last else 'booting',
                                  harness_at=now if last else session.harness_at))

    def _work(self, session: AgentSession, lease: Lease | None, now: int) -> AgentSession:
        if lease is not None and lease.ended:
            return self._task_ended(session, lease, now)
        return self._working(session, lease, now)

    def _task_ended(self, session: AgentSession, lease: Lease, now: int) -> AgentSession:
        """Its task has ended on the board: however its harness exits, or at the hard stop if it does not, the session
        ends as the task did, never continued nor re-posted."""
        # A suspended one runs nothing: ended at once (its session is not kept until the hard stop).
        exited = session.suspended or self._vm_call(
            lambda: self.runtime.poll_exec(session.vm, str(session.exec_id))) is not None
        if exited or now - session.started_at >= self.timings.hard_stop:
            return self._end(session, ENDED_AS.get(lease.final_state, 'failed'), now)
        return session

    def _working(self, session: AgentSession, lease: Lease | None, now: int) -> AgentSession:
        if not session.suspended:
            vm, running = session.vm, str(session.exec_id)
            result = self._vm_call(lambda: self.runtime.poll_exec(vm, running))
            if result is not None:
                return self._harness_ended(session, result, now)
        if (session.status == 'pause_requested' and session.after_pause in ('shutdown', 'wait')
                and session.pause_requested_at is not None
                and now - session.pause_requested_at >= self.timings.answer_window):
            # A Shut down, or a long wait's pause, whose checkpoint does not come: held as asked (stopped, or
            # waiting without a session) from its last checkpoint, rather than kept awake.
            return self._end(session, HELD_AS[session.after_pause], now)
        verdict = judge(session, lease, now, self.timings)
        if verdict == 'clear_ask':
            return replace(session, asked_at=None)
        if verdict == 'ask_state':
            minutes = self.timings.stall_after // 60
            self._emit(session, session.agent_id, 'question',
                          f'No progress for {minutes} minutes: what is your state?')
            return replace(session, asked_at=now)
        if verdict == 'pause':
            self._emit(session, session.agent_id, 'pause',
                          'This session nears its limit: finish the step, checkpoint, and pause.')
            return replace(session, status='pause_requested', pause_requested_at=now, after_pause='continue')
        if verdict == 'stalled':
            return self._stalled(session, now)
        if verdict == 'crashed':
            return self._crashed(session, now)
        return session

    @staticmethod
    def _with_exit(session: AgentSession, result: ExecResult) -> AgentSession:
        """The failed command's outcome in the inspection data, so the run monitor can say why it crashed."""
        # Whole seconds: DynamoDB takes no floats.
        last_exit = {'exit_code': result.exit_code, 'timed_out': result.timed_out,
                     'duration_seconds': round(result.duration_seconds),
                     'stdout_tail': result.stdout_tail[-500:], 'stderr_tail': result.stderr_tail[-500:]}
        return replace(session, inspect={**session.inspect, 'last_exit': last_exit})

    def _harness_ended(self, session: AgentSession, result: ExecResult, now: int) -> AgentSession:
        outcome = ended(result.exit_code, result.timed_out)
        if outcome == 'done':
            return self._end(session, 'done', now)
        if outcome == 'crashed':
            return self._crashed(self._with_exit(session, result), now)
        held = HELD_AS.get(session.after_pause)
        if held is not None:
            return self._end(session, held, now)
        return self._continue(session, now, crashed=False)

    def _stalled(self, session: AgentSession, now: int) -> AgentSession:
        self._emit(session, 'run', 'timed_out', f'{session.agent_id} stopped answering.')
        held = HELD_AS.get(session.after_pause)
        if held is not None:
            # A person's Pause or Shut down (or a spent budget) is kept: the agent is held from its last checkpoint.
            return self._end(session, held, now)
        if session.role == 'coordinator':
            # Not a task on the board: restarted like a crash, and after too many in a row, the run goes to a person.
            return self._crashed(session, now)
        self.board.repost(session.run_id, session.task_id, 'stalled', attempt=session.task_attempt)
        return self._end(session, 'reposted', now)

    def _crashed(self, session: AgentSession, now: int) -> AgentSession:
        held = HELD_AS.get(session.after_pause)
        if held is not None:
            return self._end(session, held, now)
        if session.crashes < self.timings.max_crash_continuations:
            return self._continue(session, now, crashed=True)
        self._emit(session, 'run', 'failed', f'{session.agent_id} crashed {session.crashes + 1} times.')
        if session.role == 'coordinator':
            # Its session failed first, then the run goes to a person: a Resume landing between the two then finds
            # the coordinator failed and replaces it, never a session still kept (and nothing to replace).
            ended = self._end(session, 'failed', now)
            self.control.needs_human(session.run_id, 'coordinator')
            return ended
        self.board.repost(session.run_id, session.task_id, 'crashed', attempt=session.task_attempt)
        return self._end(session, 'reposted', now)

    def _continue(self, session: AgentSession, now: int, *, crashed: bool) -> AgentSession:
        """End the session and go on as the same agent and task in a new one, from the last checkpoint; never for a
        task that moved on or ended (every path here: a tick, a wake, a person's Resume)."""
        if session.run_id in self._held:
            return self._end(session, 'paused', now)
        lease = self._lease(session)
        gone = self._gone(session, lease, now)
        if gone is not None:
            return gone
        if lease is not None and lease.agent_id and not self._refreshed(session):
            # Refused before any session starts: the task is not this agent's at this attempt any more. (Its lease is
            # refreshed again when its harness starts, after the boot's minutes.)
            return self._refused(session, now)
        if not self._terminate(session):
            # Never a second session beside one still running: the stop is tried again on the next move.
            raise SessionCallFailed('the old session could not be stopped')
        restore = self.checkpoints.latest(session.run_id, session.agent_id, session.commit, session.task_attempt)
        spec = session.spec(restore, self.workspace_bucket, self.board_url, self.broker_url)
        try:
            vm = self._vm_call(lambda: self.runtime.run(spec))
        except SessionCallFailed as failed:
            if isinstance(failed.__cause__, SessionsFull):
                return self._no_room(session, now)
            # A crash whose new session will not start counts as one more crash (every crash is a running agent's),
            # so one that never starts is escalated like an agent that keeps crashing (its task re-posted, a
            # coordinator's run sent to a person), never tried again on every tick. Any other continuation leaves
            # the row as it was: a pause's comes back here as a crash once its failures add up, and an agent held
            # without a session is tried again (a wake's once-per-wait mark is not spent by a start that failed).
            if crashed:
                try:
                    self._save(replace(session, crashes=session.crashes + 1))
                except Exception:
                    logger.exception('engineering supervisor: a failed start could not be counted as a crash',
                                     extra={'run_id': session.run_id, 'agent_id': session.agent_id})
            raise
        continued = replace(session.on(vm, now, restore), crashes=session.crashes + 1 if crashed else 0,
                            **self._counted(session, now))
        try:
            saved = self._save(continued)
        except Exception:
            # The row does not name the session just started (someone else moved it, or the write failed): it would
            # belong to nobody. Stopped now, or, when that fails too, kept on a row of its own the tick stops again.
            # (unless the write landed after all, its answer lost: the row names it, so it is not lost, and goes on)
            landed = landed_session(self.sessions, session.run_id, session.agent_id, vm)
            if landed is not None:
                saved = landed
            else:
                stop_or_keep_lost(self.runtime, self.sessions, session.run_id, session.agent_id, session.role, vm,
                                  now)
                raise
        refs = {'continuation': str(saved.continuation), 'after': 'crash' if crashed else 'pause',
                'checkpoint': restore or 'none'}
        self._emit(session, 'run', 'continued',
                      f'{session.agent_id} continued in a new session ({saved.continuation}).', refs)
        return saved

    def _no_room(self, session: AgentSession, now: int) -> AgentSession:
        """No room for a new session now (the service's own quota answer, as a launch gets): no crash. The agent is
        held without a session and continued again every tick until there is room; after ``max_no_room`` ticks in a
        row it goes to a person (held, ``paused``: their Resume continues it), never waits without end."""
        tries = session.no_room + 1
        if tries >= self.timings.max_no_room:
            self._emit(session, 'run', 'failed',
                       f'{session.agent_id} found no free agent session {tries} times in a row: held for a person.')
            return self._end(replace(session, no_room=0), 'paused', now)
        full = {**session.inspect, 'last_failure': 'no free agent session: continued once one ends'}
        return self._save(replace(session, status='waiting', exec_id=None, suspended=False, inspect=full,
                                  no_room=tries, **self._counted(session, now), last_tick_at=now))

    def _retry_lost(self, run_id: str, now: int) -> None:
        """Stop again every session of the run no row names (``SessionStore.record_lost``), counting its time."""
        for lost in self.sessions.lost(run_id):
            # One row's failure (its stop, its count) never keeps the run's other lost sessions from theirs.
            try:
                self._retry_one_lost(lost, now)
            except Exception:
                logger.exception('engineering supervisor: a lost session could not be counted',
                                 extra={'run_id': run_id, 'agent_id': lost.agent_id, 'vm_id': lost.vm.vm_id})

    def _retry_one_lost(self, lost: LostSession, now: int) -> None:
        current = self.sessions.get(lost.run_id, lost.agent_id)
        if current is not None and current.vm_id == lost.vm.vm_id:
            # Its agent's row names it after all (a read-back that failed, a late write that landed after it): it is that
            # row's session, counted and stopped there. The lost row is closed without counting it twice or stopping it.
            self.sessions.lost_named(lost, now)
            logger.warning('engineering supervisor: a lost session is its agent\'s after all',
                           extra={'run_id': lost.run_id, 'agent_id': lost.agent_id, 'vm_id': lost.vm.vm_id})
            return
        stopped = True
        try:
            self.runtime.terminate(lost.vm)
        except Exception:
            stopped = False
            logger.exception('engineering supervisor: a lost session could not be stopped',
                             extra={'run_id': lost.run_id, 'agent_id': lost.agent_id, 'vm_id': lost.vm.vm_id})
        self.sessions.lost_tick(lost, now, stopped=stopped)
        if stopped:
            logger.warning('engineering supervisor: a lost session is stopped',
                           extra={'run_id': lost.run_id, 'agent_id': lost.agent_id, 'vm_id': lost.vm.vm_id,
                                  'lost_seconds': now - lost.recorded_at})

    def _ask_pause(self, session: AgentSession, now: int, after: After) -> AgentSession:
        return self._save(replace(session, status='pause_requested', pause_requested_at=now, after_pause=after))

    @staticmethod
    def _counted(session: AgentSession, now: int) -> dict[str, int]:
        """The session's seconds since the last tick, added to its counters: running (``microvm_seconds``) or held for
        an open wait (``held_seconds``: its memory still counts); none without a session."""
        if (session.status not in WITH_SESSION and not session.stop_pending) or session.last_tick_at is None:
            return {}
        elapsed = max(now - session.last_tick_at, 0)
        if session.suspended:
            return {'held_seconds': session.held_seconds + elapsed}
        return {'microvm_seconds': session.microvm_seconds + elapsed}

    def _terminate(self, session: AgentSession) -> bool:
        """End the agent's session, if it has one; whether it is ended (one already gone is). A refused call is logged
        and answered False: the caller keeps the session to end (``stop_pending``), never forgets it."""
        if session.status not in WITH_SESSION and not session.stop_pending:
            return True
        try:
            self.runtime.terminate(session.vm)
        except Exception:
            logger.exception('engineering supervisor: a session could not be ended',
                             extra={'run_id': session.run_id, 'agent_id': session.agent_id})
            return False
        return True

    def _end(self, session: AgentSession, status: Status, now: int) -> AgentSession:
        """The session ended as ``status``. When its stop fails, it keeps the status with ``stop_pending``: every tick
        tries the stop again (``_retry_stop``) and counts its time meanwhile (it may still run: its runner says busy)."""
        if session.stop_pending:
            return self._retry_stop(session, now)
        stopped = self._terminate(session)
        return self._save(replace(session, status=status, exec_id=None, suspended=False, stop_pending=not stopped,
                                  **self._counted(session, now), last_tick_at=now))

    def _retry_stop(self, session: AgentSession, now: int) -> AgentSession:
        """Stop again a session whose stop failed; its time since the last tick is counted either way."""
        stopped = self._terminate(session)
        return self._save(replace(session, stop_pending=not stopped, **self._counted(session, now), last_tick_at=now))

    def _save(self, session: AgentSession) -> AgentSession:
        return self.sessions.save(session)

    # --- the run monitor's controls -------------------------------------------------------------

    def signal(self, run_id: str, agent_id: str | None, kind: str, now: int) -> dict[str, str]:
        """The run monitor's control on one agent (``agent_id``) or every agent of the run; each one's status."""
        return {agent: status for agent, (status, _) in self.signal_detailed(run_id, agent_id, kind, now).items()}

    def _may_resume(self, run_id: str, now: int) -> None:
        """Refuse a Resume of a run that ended, is past its 30 days or spent its budget; else its budget no longer
        holds it."""
        if self.control.stop_requested(run_id):
            raise RuntimeRefused(f'run {run_id} is stopped: it cannot be resumed')
        if now - self.control.started_at(run_id) >= THIRTY_DAYS:
            raise RuntimeRefused(f'run {run_id} is past its 30 days: it can only be stopped')
        if self.control.budget(run_id).exceeded:
            raise RuntimeRefused(f'run {run_id} has spent its budget: raise it before resuming')
        # Its budget is no longer spent, and a person decided: a held run may start sessions again.
        self._held.discard(run_id)

    def signal_detailed(self, run_id: str, agent_id: str | None, kind: str, now: int,
                        attempt: int | None = None) -> dict[str, tuple[str, bool]]:
        """``signal``, with whether the signal took effect on each agent: not when another move holds it
        (``busy``), when its move failed (a refused port, a session call), when there was nothing to do in the agent's
        state (its current status; a final one means nothing to send again), or, given the ``attempt`` of the task
        the caller saw on that one agent, when the agent works on another one (``stale``: nothing done). A Stop now
        is never stale: a person's kill switch reaches whatever attempt the agent is on."""
        if kind not in SIGNALS:
            raise RuntimeRefused(f'unknown signal {kind!r}')
        if kind == 'resume':
            self._may_resume(run_id, now)
        if attempt is not None and agent_id is None:
            raise RuntimeRefused('an attempt names one agent\'s task: send it with agent_id')
        targets = [session for session in self.sessions.of_run(run_id)
                   if agent_id is None or session.agent_id == agent_id]
        if agent_id is not None and not targets:
            raise RuntimeRefused(f'run {run_id} has no agent {agent_id}')
        answers: dict[str, tuple[str, bool]] = {}
        done: set[str] = set()

        def signalled(session: AgentSession) -> AgentSession:
            moved = self._signal_one(session, kind, now)
            if moved is not session:
                # Something moved: nothing to do in the agent's state is not "applied".
                done.add(session.agent_id)
            return moved

        for session in targets:
            if attempt is not None and session.task_attempt != attempt and kind != 'stop_now':
                answers[session.agent_id] = ('stale', False)
                continue
            try:
                status = self._guarded(session, now, signalled).status
            except SessionBusy:
                # Another move is under way on this agent: nothing was done; the caller sends the signal again.
                answers[session.agent_id] = ('busy', False)
                continue
            # ``_guarded`` logs a failed move and keeps the session as it was: nothing took effect.
            answers[session.agent_id] = (status, session.agent_id in done)
        return answers

    def wake(self, run_id: str, addressee: Callable[[AgentSession], bool], now: int) -> dict[str, str]:
        """A message for these agents of the run is in their inbox (``delivery.py``): each working or waiting one is
        woken to read it (a booting or pausing one reads its inbox once it runs, so it is left alone); each woken
        one's status, or ``busy`` when another move holds it (the caller tries again).

        Nobody is woken in a run that ended, is past its 30 days or spent its budget: the message waits in the inbox
        (this runs outside the tick, so it checks the run itself rather than the tick's view of it).
        """
        if (self.control.stop_requested(run_id) or now - self.control.started_at(run_id) >= THIRTY_DAYS
                or self.control.budget(run_id).exceeded):
            return {}
        answers: dict[str, str] = {}
        done: set[str] = set()

        def woken(session: AgentSession) -> AgentSession:
            moved = self._woken(session, now)
            done.add(session.agent_id)
            return moved

        for session in self.sessions.of_run(run_id):
            if session.status not in ('working', 'waiting') or not addressee(session):
                continue
            try:
                answer = self._guarded(session, now, woken).status
            except SessionBusy:
                answer = 'busy'
            # A wake that failed (a session or launcher call; ``_guarded`` records it) is tried again, like a busy one.
            answers[session.agent_id] = answer if session.agent_id in done else 'busy'
        return answers

    def _woken(self, session: AgentSession, now: int) -> AgentSession:
        """Held without a session on a long wait: continued in a new one, which reads the message, once per wait (a
        later message waits for the wait to close). Working (its session suspended for an open wait, or about to be):
        resumed with a fresh role session and kept awake for ``wake_grace``, which a later message does not extend;
        the wait's 45-minute hold still counts meanwhile."""
        if session.status == 'waiting':
            # Held for a wait the tick saw open (one held before ``wait_since`` existed: this wait, from now).
            wait = session.wait_since if session.wait_since is not None else now
            if session.woken_wait == wait:
                return session
            # The once-per-wait record goes in the same write that names the new session; its grace starts when its
            # harness does (``_boot``), so a slow checkout does not eat it.
            return self._continue(replace(session, wait_since=wait, woken_wait=wait,
                                          woken_continuation=session.continuation + 1), now, crashed=False)
        in_grace = session.woken_at is not None and now - session.woken_at < self.timings.wake_grace
        # A continuation's one grace is never moved by a later message; nor is a running one. An agent the tick has
        # not seen on a wait gets none (it reads its inbox as it works).
        keep = in_grace or self._continued_for_a_message(session) or session.wait_since is None
        return self._save(replace(self._renew(self._wake(session), now), woken_at=session.woken_at if keep else now))

    def _signal_paused(self, session: AgentSession, kind: str, now: int) -> AgentSession:
        if kind == 'resume':
            return self._continue(session, now, crashed=False)
        if kind in ('shutdown', 'stop_now'):
            # Already checkpointed and without a session: either makes it final, so a later Resume skips it.
            return self._end(session, 'stopped', now)
        return session

    def _signal_one(self, session: AgentSession, kind: str, now: int) -> AgentSession:
        if session.status == 'paused':
            return self._signal_paused(session, kind, now)
        if kind == 'stop_now' and session.status in LIVE_STATUSES:
            return self._end(session, 'stopped', now)
        if session.status in ('waiting', 'booting') and kind in ('pause', 'shutdown'):
            # Held for a long wait (its checkpoint saved, no session), or still booting (nothing to checkpoint yet:
            # Resume continues it from its last checkpoint): a person's call decides at once.
            return self._end(session, 'stopped' if kind == 'shutdown' else 'paused', now)
        if kind == 'resume' and session.status == 'pause_requested' and session.after_pause == 'hold':
            return self._save(replace(session, after_pause='continue'))
        if session.status not in ('working', 'pause_requested'):
            return session
        # A signal is a message to the agent: a session suspended for an open wait is woken (and its session
        # renewed) to read it.
        before = session
        session = self._renew(self._wake(session), now)
        if kind == 'save':
            self._emit(session, session.agent_id, 'save', 'Save a checkpoint now.')
            return self._save(session)
        if kind in ('pause', 'shutdown'):
            # Already pausing (its 8-hour pause, a long wait): a person's pause or shut down decides what follows;
            # shut down outranks a hold.
            after: After = 'shutdown' if kind == 'shutdown' or session.after_pause == 'shutdown' else 'hold'
            if session.status == 'working':
                self._emit(session, session.agent_id, 'pause', 'Finish the step, checkpoint, and pause.')
            return self._ask_pause(session, now, after)
        # A Resume of an agent that runs (or pauses to continue, or to shut down: a Shut down outranks it) does nothing
        # but the wake and renewal above: nothing to save, and so not applied, when neither moved anything.
        return self._save(session) if session != before else before
