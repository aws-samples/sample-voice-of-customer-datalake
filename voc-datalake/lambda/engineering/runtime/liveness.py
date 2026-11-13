"""What the supervisor does with one working agent, decided from its clocks alone (no I/O here).

The harness tells the supervisor how a session ended by its exit code: 0 the task is done, 75 (the
sysexits "temporary failure" code) it paused after saving its checkpoint (a pause the supervisor asked for, a person's
pause, or one the agent chose before a step longer than its session has left), anything else a crash.
While the harness runs, ``judge`` reads the session's age and the task's lease (heartbeat and progress).
"""
from __future__ import annotations

from typing import Final, Literal

from engineering.runtime.caps import Timings
from engineering.runtime.ports import Lease
from engineering.runtime.sessions import AgentSession

#: The harness's exit code for "paused: my checkpoint is saved, continue me in a new session".
PAUSED_EXIT_CODE: Final = 75

Verdict = Literal['ok', 'clear_ask', 'ask_state', 'pause', 'stalled', 'crashed']


def ended(exit_code: int, timed_out: bool) -> Literal['done', 'paused', 'crashed']:
    """How the harness ended."""
    if timed_out:
        return 'crashed'
    if exit_code == 0:
        return 'done'
    return 'paused' if exit_code == PAUSED_EXIT_CODE else 'crashed'


def judge(session: AgentSession, lease: Lease | None, now: int, timings: Timings) -> Verdict:
    """The verdict on a session whose harness is still running."""
    age = now - session.started_at
    if age >= timings.hard_stop:
        # Even on an open wait: a session that has not paused by its hard stop is ended.
        return 'crashed'
    if lease is not None and lease.waiting:
        # On an open wait: outside every other clock (the supervisor suspends it, or holds it for a long wait).
        return 'ok'
    if session.status == 'working' and age >= timings.pause_after:
        return 'pause'
    if lease is None or now - lease.renewed_at > timings.lease_ttl:
        return 'crashed'
    if session.asked_at is not None:
        if lease.last_progress_at > session.asked_at:
            return 'clear_ask'
        return 'stalled' if now - session.asked_at >= timings.answer_window else 'ok'
    if now - lease.last_progress_at >= timings.stall_after:
        return 'ask_state'
    return 'ok'
