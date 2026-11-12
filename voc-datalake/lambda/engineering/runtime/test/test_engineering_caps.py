"""No fixed task cap: the supervisor's clocks, and the liveness verdicts they give."""
from dataclasses import replace

import pytest

from engineering.runtime import caps
from engineering.runtime.interface import RuntimeRefused
from engineering.runtime.liveness import PAUSED_EXIT_CODE, ended, judge
from engineering.runtime.ports import Lease
from engineering.runtime.sessions import AgentSession

T = caps.Timings()
SESSION = AgentSession(run_id='run-1', agent_id='fixer-1', role='fixer', task_id='task-1', language='python',
                       egress=(), connection='repo-1', commit='a' * 40, paths=(), harness=('true',), vm_id='vm',
                       endpoint='https://vm.example.org', started_at=0, status='working', exec_id='e1')


def _lease(renewed: int, progress: int) -> Lease:
    return Lease(task_id='task-1', agent_id='fixer-1', renewed_at=renewed, last_progress_at=progress)


def test_the_defaults_are_ten_minutes_of_quiet_and_a_pause_at_seven_and_a_half_hours():
    timings = caps.timings()
    assert (timings.stall_after, timings.pause_after) == (600, 27000)
    assert timings.hard_stop == 8 * 3600 - 600


def test_a_run_may_set_its_own_clocks_within_their_bounds():
    assert caps.timings({'stall_after': 300, 'pause_after': 4 * 3600}) == replace(T, stall_after=300,
                                                                                   pause_after=4 * 3600)


@pytest.mark.parametrize('raw', [{'stall_after': 60}, {'stall_after': 7200}, {'pause_after': 7 * 3600 + 41 * 60},
                                 {'pause_after': 1800}, {'stall_after': '600'}, {'stall_after': True}],
                         ids=['stall-short', 'stall-long', 'pause-late', 'pause-early', 'string', 'bool'])
def test_clocks_outside_their_bounds_are_refused_never_clamped(raw):
    with pytest.raises(RuntimeRefused):
        caps.timings(raw)


def test_a_clock_that_cannot_be_set_is_refused():
    with pytest.raises(RuntimeRefused, match="unknown timing 'hard_stop'"):
        caps.timings({'hard_stop': 9 * 3600})


@pytest.mark.parametrize(('exit_code', 'timed_out', 'outcome'), [
    (0, False, 'done'), (PAUSED_EXIT_CODE, False, 'paused'), (1, False, 'crashed'), (0, True, 'crashed'),
], ids=['done', 'paused', 'failed', 'timed-out'])
def test_how_a_harness_ended_comes_from_its_exit_code(exit_code, timed_out, outcome):
    assert ended(exit_code, timed_out) == outcome


@pytest.mark.parametrize(('session', 'lease', 'now', 'verdict'), [
    (SESSION, _lease(100, 100), 120, 'ok'),
    (SESSION, None, 120, 'crashed'),
    (SESSION, _lease(100, 100), 100 + T.lease_ttl + 1, 'crashed'),
    (SESSION, _lease(T.hard_stop, T.hard_stop), T.hard_stop, 'crashed'),
    (SESSION, _lease(T.pause_after, T.pause_after), T.pause_after, 'pause'),
    (replace(SESSION, status='pause_requested'), _lease(T.pause_after, T.pause_after), T.pause_after, 'ok'),
    (SESSION, _lease(T.stall_after, 0), T.stall_after, 'ask_state'),
    (replace(SESSION, asked_at=700), _lease(800, 750), 800, 'clear_ask'),
    (replace(SESSION, asked_at=700), _lease(800, 0), 700 + T.answer_window - 1, 'ok'),
    (replace(SESSION, asked_at=700), _lease(880, 0), 700 + T.answer_window, 'stalled'),
    (SESSION, replace(_lease(0, 0), waiting=True), 5000, 'ok'),
    (SESSION, replace(_lease(0, 0), waiting=True), T.stall_after + T.lease_ttl + T.answer_window, 'ok'),
    (SESSION, replace(_lease(0, 0), waiting=True), T.hard_stop, 'crashed'),
], ids=['quiet-but-fine', 'no-lease', 'lease-lapsed', 'hard-stop', 'pause', 'already-pausing', 'ask', 'answered',
        'waiting-for-answer', 'no-answer', 'open-wait', 'open-wait-past-the-activity-clocks',
        'open-wait-at-the-hard-stop'])
def test_judge(session, lease, now, verdict):
    assert judge(session, lease, now, T) == verdict
