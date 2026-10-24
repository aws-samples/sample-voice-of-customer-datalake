"""The plan conductor's ``decide``: settle what changed, then tell the state machine what to do next.

One pass (docs/assistant-plan-mode.md → "Runtime", "Failure, cancel, expiry"):

1. an approved plan starts (``running``); a cancelled / expired / finished plan ends the execution;
2. settle until nothing changes: a step left ``running`` (its result was lost) fails; a paused step
   older than 30 minutes fails; each ``waiting`` step is polled; a ready ``wait`` step starts waiting;
   a pending step after a failed / skipped / cancelled one is skipped;
3. directive: ``execute`` up to 3 ready write/think steps (the state machine runs them through
   ``plan_execution``), else ``wait`` while anything is outstanding or still pending, else ``finish``.
   A pending step always has a next transition (start, skip, execute), so a plan never finishes
   around one: a wait whose start lost a race, or that the settle cap left unstarted, is started
   by the next decide.

The conductor never runs a write itself, and it never trusts a step: every transition is conditional.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Final

from agents import plan_waits
from agents.conductor import plan_state
from agents.conductor.plan_state import PlanState
from shared import agents_store
from shared import plans_store as ps
from shared.agents_store import iso, parse_iso

MAX_PARALLEL_STEPS: Final = 3          # the state machine's Map concurrency
MAX_SETTLE_PASSES: Final = 25          # > the 20-step plan limit: one change per pass at worst
APPROVAL_TIMEOUT: Final = timedelta(minutes=30)
# Poll every 30 s for the first hour, then every 2 min, so a 24 h plan stays far below the
# Step Functions history limit (25,000 events) — a paused step is always polled every 30 s.
FAST_WAIT_SECONDS: Final = 30
SLOW_WAIT_SECONDS: Final = 120
FAST_PHASE: Final = timedelta(hours=1)
OUTSTANDING: Final = (ps.STEP_RUNNING, ps.STEP_WAITING, ps.STEP_NEEDS_APPROVAL)
# Not finished: a plan with one of these steps waits for the next decide instead of finishing.
UNFINISHED: Final = (*OUTSTANDING, ps.STEP_PENDING)
UNSUCCESSFUL: Final = (ps.STEP_FAILED, ps.STEP_SKIPPED, ps.STEP_CANCELLED)
# A done think step's result opens with this much in the plan summary (≤ 4 thinks fit MAX_SUMMARY_CHARS).
SUMMARY_EXCERPT_CHARS: Final = 240
STOPPED_STEP_ERROR: Final = 'The plan stopped before this step ran.'


def _finish_directive(status: str) -> dict:
    return {'kind': 'finish', 'status': status}


def _fail(state: PlanState, step_id: str, error: str, when: tuple[str, ...]) -> bool:
    done = ps.finish_step(plan_state.table(), state.plan_id, step_id, ps.STEP_FAILED, now=state.now,
                          when=when, error=error)
    if done is not None:
        ps.append_event(plan_state.table(), state.plan_id, 'step_failed', error, now=state.now, step_id=step_id)
    return done is not None


def _older_than(value: object, state: PlanState, age: timedelta) -> bool:
    moment = parse_iso(value)
    return moment is not None and state.now - moment >= age


def _poll_wait(state: PlanState, step_id: str) -> bool:
    row, wait = state.rows[step_id], state.definitions[step_id].get('wait') or {}
    if _older_than(row.get('started_at'), state, timedelta(minutes=plan_waits.timeout_minutes(wait))):
        return _fail(state, step_id, 'The wait timed out.', (ps.STEP_WAITING,))
    result = plan_waits.poll(wait, state.outputs(think=False))
    if result.status == plan_waits.WAIT_DONE:
        return ps.finish_step(plan_state.table(), state.plan_id, step_id, ps.STEP_DONE, now=state.now,
                              when=(ps.STEP_WAITING,), outputs=result.outputs) is not None
    if result.status == plan_waits.WAIT_FAILED:
        return _fail(state, step_id, result.error or 'The job failed.', (ps.STEP_WAITING,))
    return False


def _start_wait(state: PlanState, step_id: str) -> bool:
    return ps.update_step(plan_state.table(), state.plan_id, step_id, ps.Change(
        {'status': ps.STEP_WAITING, 'started_at': iso(state.now)}, (ps.STEP_PENDING,)), now=state.now) is not None


def _skip(state: PlanState, step_id: str) -> bool:
    blocker = next(dep for dep in state.after(step_id) if state.status(dep) in UNSUCCESSFUL)
    return ps.finish_step(plan_state.table(), state.plan_id, step_id, ps.STEP_SKIPPED, now=state.now,
                          when=(ps.STEP_PENDING,), error=f'Skipped: step {blocker} did not complete.') is not None


def _settle_step(state: PlanState, step_id: str) -> bool:
    """At most one transition for one step; True when it changed something."""
    status, row = state.status(step_id), state.rows[step_id]
    if status == ps.STEP_RUNNING:
        return _fail(state, step_id, 'The step stopped before it reported a result.', (ps.STEP_RUNNING,))
    if status == ps.STEP_NEEDS_APPROVAL and _older_than(row.get('pending_since'), state, APPROVAL_TIMEOUT):
        return _fail(state, step_id, 'No one approved the paused write within 30 minutes.', (ps.STEP_NEEDS_APPROVAL,))
    if status == ps.STEP_WAITING:
        return _poll_wait(state, step_id)
    if status != ps.STEP_PENDING:
        return False
    if any(state.status(dep) in UNSUCCESSFUL for dep in state.after(step_id)):
        return _skip(state, step_id)
    if state.definitions[step_id].get('kind') == 'wait' and state.dependencies_done(step_id):
        return _start_wait(state, step_id)
    return False


def _settle(state: PlanState) -> PlanState:
    for _ in range(MAX_SETTLE_PASSES):
        changed = [step_id for step_id in state.order if _settle_step(state, step_id)]
        reloaded = plan_state.load(state.plan_id, state.now)
        if reloaded is None:
            return state
        state = reloaded
        if not changed:
            break
    return state


def _step_line(state: PlanState, step_id: str) -> str | None:
    """One summary line: an unsuccessful step's error, or the start of a done think step's result."""
    title = state.definitions.get(step_id, {}).get('title') or step_id
    status = state.status(step_id)
    if status in UNSUCCESSFUL:
        return f"{step_id} ({title}) {status}: {state.rows[step_id].get('error') or ''}".strip()
    outputs = state.rows[step_id].get('outputs')
    if status != ps.STEP_DONE or state.definitions.get(step_id, {}).get('kind') != 'think' or not isinstance(outputs, dict):
        return None
    text = ' '.join(' '.join(str(value).split()) for value in outputs.values())
    excerpt = text if len(text) <= SUMMARY_EXCERPT_CHARS else f'{text[:SUMMARY_EXCERPT_CHARS].rstrip()}...'
    return f'{step_id} ({title}): {excerpt}' if excerpt else None


def _summary(state: PlanState) -> str:
    done = [s for s in state.order if state.status(s) == ps.STEP_DONE]
    lines = [f'{len(done)} of {len(state.order)} steps done.']
    lines.extend(line for step_id in state.order if (line := _step_line(state, step_id)) is not None)
    return '\n'.join(lines)


def _finish(state: PlanState) -> dict:
    complete = all(state.status(step_id) == ps.STEP_DONE for step_id in state.order)
    status = ps.PLAN_COMPLETED if complete else ps.PLAN_COMPLETED_WITH_ERRORS
    if ps.finish_plan(plan_state.table(), state.plan_id, status, now=state.now, summary=_summary(state)) is None:
        reloaded = plan_state.load(state.plan_id)
        return _finish_directive(str((reloaded.meta if reloaded else {}).get('status') or ps.PLAN_CANCELLED))
    ps.append_event(plan_state.table(), state.plan_id, 'plan_finished', f'Plan {status}', now=state.now)
    return _finish_directive(status)


def _wait_seconds(state: PlanState) -> int:
    paused = any(state.status(step_id) == ps.STEP_NEEDS_APPROVAL for step_id in state.order)
    if paused or not _older_than(state.meta.get('started_at'), state, FAST_PHASE):
        return FAST_WAIT_SECONDS
    return SLOW_WAIT_SECONDS


def _directive(state: PlanState) -> dict:
    ready = [step_id for step_id in state.order
             if state.status(step_id) == ps.STEP_PENDING and state.dependencies_done(step_id)
             and state.definitions[step_id].get('kind') != 'wait']
    if ready:
        return {'kind': 'execute', 'steps': ready[:MAX_PARALLEL_STEPS]}
    if any(state.status(step_id) in UNFINISHED for step_id in state.order):
        return {'kind': 'wait', 'wait_seconds': _wait_seconds(state)}
    return _finish(state)


def _start(state: PlanState) -> PlanState:
    """An approved plan (not stale) → ``running``; the state as it now is."""
    meta = ps.expire_if_stale(plan_state.table(), state.meta, now=state.now)
    if meta.get('status') != ps.PLAN_APPROVED:
        return plan_state.load(state.plan_id, state.now) or state
    started = ps.update_meta(plan_state.table(), state.plan_id, ps.Change(
        {'status': ps.PLAN_RUNNING, 'started_at': iso(state.now)}, (ps.PLAN_APPROVED,)), now=state.now)
    if started is not None:
        ps.append_event(plan_state.table(), state.plan_id, 'plan_running', 'Plan started', now=state.now)
    return plan_state.load(state.plan_id, state.now) or state


def decide(plan_id: str) -> dict:
    state = plan_state.load(plan_id)
    if state is None:
        return _finish_directive(ps.PLAN_FAILED)
    if state.meta.get('status') == ps.PLAN_APPROVED:
        state = _start(state)
    status = str(state.meta.get('status') or ps.PLAN_FAILED)
    if status != ps.PLAN_RUNNING:
        if status == ps.PLAN_CANCELLED:
            ps.close_open_steps(plan_state.table(), plan_id, now=state.now)
        return _finish_directive(status)
    return _directive(_settle(state))


def stop(plan_id: str, summary: str) -> dict:
    """End an active plan as ``failed`` (an internal error, a refused approver); open steps are skipped."""
    table, now = plan_state.table(), agents_store.utc_now()
    if ps.finish_plan(table, plan_id, ps.PLAN_FAILED, now=now, summary=summary) is not None:
        ps.close_open_steps(table, plan_id, now=now, status=ps.STEP_SKIPPED, error=STOPPED_STEP_ERROR)
        ps.append_event(table, plan_id, 'plan_failed', summary, now=now)
    return _finish_directive(ps.PLAN_FAILED)
