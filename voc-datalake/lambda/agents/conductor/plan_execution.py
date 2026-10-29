"""Run one plan step: ``prepare`` before ``voc-plan-step``, ``record`` after it (docs/assistant-plan-mode.md).

The state machine's Map runs, per ready step: ``plan_prepare`` (here) → ``voc-plan-step`` (TypeScript,
built from lambda/stream: the matching, the free-field fill and the write itself) → ``plan_record`` (here).
The conductor never executes a write and never waits on one.

``prepare`` claims the step (``pending`` → ``running``), applies the per-plan caps, re-checks the
approver in Cognito (``agents.plan_identity``) and builds the plan-step event::

    {plan_id, step, resolved: {"sN.out": v}, think_outputs: {"sN.out": text}, claims, approved_pending?}

``record`` accepts exactly one of the plan-step answers — ``done`` (outputs), ``needs_approval`` (the
write it refused to run, whose fingerprint we recompute) or ``failed`` — or the state machine's error.
"""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from typing import Any, Final

from agents import plan_identity
from agents.conductor import plan_decide, plan_state
from agents.conductor.plan_state import PlanState
from shared import plans_store as ps
from shared.agents_store import iso
from shared.logging import logger
from shared.memory_policy import redact_personal_data
from shared.plan_canonical import FINGERPRINT_RE, CanonicalJsonError, canonical_write_fingerprint
from shared.plan_schema import CARD_ONLY_WRITE_TOOLS, NEVER_PREAPPROVABLE_TOOLS, THINK_DEFAULT_OUTPUT

NOT_RUN: Final = {'run': False}
MAX_PENDING_JSON_CHARS: Final = 32_000
MAX_MODEL_CALLS_PER_STEP: Final = 100
EMPTY_THINK_ERROR: Final = 'The analysis step finished without a result, so nothing was stored.'
_TOOL_RE: Final = re.compile(r'[a-z_]{1,64}')


# --------------------------------------------------------------------------
# prepare
# --------------------------------------------------------------------------

def _fail_step(state: PlanState, step_id: str, error: str) -> dict:
    ps.finish_step(plan_state.table(), state.plan_id, step_id, ps.STEP_FAILED, now=state.now,
                   when=(ps.STEP_PENDING, ps.STEP_RUNNING), error=error)
    ps.append_event(plan_state.table(), state.plan_id, 'step_failed', error, now=state.now, step_id=step_id)
    return NOT_RUN


def _runnable(state: PlanState | None, step_id: str) -> bool:
    if state is None or state.meta.get('status') != ps.PLAN_RUNNING:
        return False
    definition = state.definitions.get(step_id)
    return (definition is not None and definition.get('kind') in ('write', 'think')
            and state.status(step_id) == ps.STEP_PENDING and state.dependencies_done(step_id))


def _approved_pending(row: Mapping[str, Any]) -> dict | None:
    pending = ps.decode_json(row.get('approved_pending_json'))
    if not isinstance(pending, dict):
        return None
    return {key: pending.get(key) for key in ('tool', 'args', 'fingerprint')}


def _event(state: PlanState, step_id: str, claims: dict[str, str]) -> dict:
    event: dict[str, Any] = {
        'plan_id': state.plan_id, 'step': state.definitions[step_id],
        'resolved': state.outputs(think=False), 'think_outputs': state.outputs(think=True), 'claims': claims,
    }
    approved = _approved_pending(state.rows[step_id])
    if approved is not None:
        event['approved_pending'] = approved
    return event


def prepare(plan_id: str, step_id: str) -> dict:
    state = plan_state.load(plan_id)
    if state is None or not _runnable(state, step_id):
        return NOT_RUN
    definition = state.definitions[step_id]
    problem = plan_state.cap_problem(state, definition)
    if problem:
        return _fail_step(state, step_id, problem)
    try:
        claims = plan_identity.approver_claims(state.meta, needs_admin=plan_state.needs_admin(definition),
                                               admin_if_current=plan_state.admin_reads(definition))
    except plan_identity.ApproverRefused as refused:
        _fail_step(state, step_id, str(refused))
        plan_decide.stop(plan_id, f'The plan stopped: {refused}')
        return NOT_RUN
    except plan_identity.DirectoryUnavailable:
        return _fail_step(state, step_id, 'The user directory could not confirm the approver.')
    claimed = ps.update_step(plan_state.table(), plan_id, step_id, ps.Change(
        {'status': ps.STEP_RUNNING, 'started_at': iso(state.now)}, (ps.STEP_PENDING,)), now=state.now)
    if claimed is None:
        return NOT_RUN
    ps.append_event(plan_state.table(), plan_id, 'step_started', str(definition.get('title') or step_id),
                    now=state.now, step_id=step_id)
    return {'run': True, 'event': _event(state, step_id, claims)}


# --------------------------------------------------------------------------
# record
# --------------------------------------------------------------------------

def _declared(definition: Mapping[str, Any]) -> list[str]:
    """The outputs a step stores: its ``produces``, or a think step's default (voc-plan-step keys its answer
    there when the step declares none — the plan that lost every analysis result in 5.09.00)."""
    declared = [str(name) for name in definition.get('produces') or []]
    if not declared and definition.get('kind') == 'think':
        return [THINK_DEFAULT_OUTPUT]
    return declared


def _output_text(definition: Mapping[str, Any], value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    if definition.get('kind') == 'think':
        # Free model text read from customer data: emails, phone numbers and secrets never stored.
        text = redact_personal_data(text).strip()
    return ps.clip(text, ps.MAX_STORED_OUTPUT_CHARS)


def _outputs(definition: Mapping[str, Any], raw: object) -> dict[str, str]:
    """Only the outputs the step declared (``_declared``), as bounded text; blank values are dropped."""
    if not isinstance(raw, dict):
        return {}
    found: dict[str, str] = {}
    for name in _declared(definition):
        value = raw.get(name)
        if value is None:
            continue
        text = _output_text(definition, value)
        if text:
            found[name] = text
    return found


def _model_calls(definition: Mapping[str, Any], result: Mapping[str, Any]) -> int:
    reported = result.get('model_calls')
    if isinstance(reported, int) and not isinstance(reported, bool) and 0 <= reported <= MAX_MODEL_CALLS_PER_STEP:
        return reported
    return 1 if plan_state.uses_model(definition) else 0


def _ran_unapproved(state: PlanState, step_id: str) -> bool:
    """Tripwire (lists from plan_contract.json): a never-pre-approvable write must have gone through the
    approver, and a card-only write may never run from a plan at all."""
    tool = plan_state.write_tool(state.definitions[step_id])
    if tool in CARD_ONLY_WRITE_TOOLS:
        return True
    return tool in NEVER_PREAPPROVABLE_TOOLS and not state.rows[step_id].get('approved_pending_json')


def _not_the_approved_write(state: PlanState, step_id: str, fingerprint: object) -> bool:
    """A step the approver resolved must report EXACTLY the write they approved (its fingerprint)."""
    approved = _approved_pending(state.rows[step_id])
    return approved is not None and (not isinstance(fingerprint, str) or fingerprint != approved.get('fingerprint'))


def _record_done(state: PlanState, step_id: str, result: Mapping[str, Any]) -> str:
    if _ran_unapproved(state, step_id):
        logger.error('Plan step reported a never-pre-approvable write as done without approval',
                     extra={'plan_id': state.plan_id, 'step_id': step_id})
        return _record_failed(state, step_id, 'The write ran without its required approval.')
    fingerprint = result.get('fingerprint')
    if _not_the_approved_write(state, step_id, fingerprint):
        logger.error('Plan step reported a write other than the approved one as done',
                     extra={'plan_id': state.plan_id, 'step_id': step_id})
        return _record_failed(state, step_id, 'The write that ran is not the one you approved.')
    definition = state.definitions[step_id]
    outputs = _outputs(definition, result.get('outputs'))
    if definition.get('kind') == 'think' and not outputs:
        return _record_failed(state, step_id, EMPTY_THINK_ERROR)
    sets: dict[str, Any] = {'status': ps.STEP_DONE, 'finished_at': iso(state.now), 'outputs': outputs}
    if isinstance(fingerprint, str) and FINGERPRINT_RE.fullmatch(fingerprint):
        sets['fingerprint'] = fingerprint
    ps.update_step(plan_state.table(), state.plan_id, step_id, ps.Change(sets, (ps.STEP_RUNNING,)), now=state.now)
    return 'step_finished'


def _verified_pending(raw: object) -> dict[str, Any] | None:
    """The paused write, when its fingerprint is the canonical one of its tool + arguments."""
    if not isinstance(raw, dict) or not isinstance(raw.get('args'), dict):
        return None
    tool, fingerprint = raw.get('tool'), raw.get('fingerprint')
    if not isinstance(tool, str) or _TOOL_RE.fullmatch(tool) is None or not isinstance(fingerprint, str):
        return None
    try:
        if canonical_write_fingerprint(tool, raw['args']) != fingerprint:
            return None
    except (CanonicalJsonError, TypeError, ValueError):
        return None
    return {'tool': tool, 'args': raw['args'], 'fingerprint': fingerprint,
            'reason': ps.clip(raw.get('reason') or 'The write differs from the approved plan.', ps.MAX_ERROR_CHARS)}


def _record_paused(state: PlanState, step_id: str, result: Mapping[str, Any]) -> str:
    pending = _verified_pending(result.get('pending'))
    if pending is None or len(encoded := json.dumps(pending)) > MAX_PENDING_JSON_CHARS:
        return _record_failed(state, step_id, 'The paused write could not be verified.')
    ps.update_step(plan_state.table(), state.plan_id, step_id, ps.Change(
        {'status': ps.STEP_NEEDS_APPROVAL, 'pending_json': encoded, 'pending_fingerprint': pending['fingerprint'],
         'pending_since': iso(state.now)},
        (ps.STEP_RUNNING,), remove=('approved_pending_json',)), now=state.now)
    return 'step_needs_approval'


def _record_failed(state: PlanState, step_id: str, error: object) -> str:
    message = error if isinstance(error, str) and error.strip() else 'The step failed.'
    ps.finish_step(plan_state.table(), state.plan_id, step_id, ps.STEP_FAILED, now=state.now,
                   when=(ps.STEP_RUNNING, ps.STEP_PENDING), error=message)
    return 'step_failed'


def _apply_result(state: PlanState, step_id: str, result: Mapping[str, Any]) -> str:
    status = result.get('status')
    if status == 'done':
        return _record_done(state, step_id, result)
    if status == 'needs_approval':
        return _record_paused(state, step_id, result)
    if status == 'failed':
        return _record_failed(state, step_id, result.get('error'))
    return _record_failed(state, step_id, 'The step returned an unexpected result.')


def record(plan_id: str, step_id: str, result: object, error: object) -> dict:
    """Record one step's outcome (``result`` from voc-plan-step, or the state machine's ``error``)."""
    state = plan_state.load(plan_id)
    if state is None or step_id not in state.rows:
        return {}
    if isinstance(error, dict):
        name = str(error.get('Error') or 'Error')[:100]
        kind = _record_failed(state, step_id, f'The step stopped on an internal error ({name}).')
        ps.append_event(plan_state.table(), plan_id, kind, name, now=state.now, step_id=step_id)
        return {}
    outcome = result if isinstance(result, dict) else {}
    kind = _apply_result(state, step_id, outcome)
    calls = _model_calls(state.definitions[step_id], outcome)
    if calls:
        ps.update_meta(plan_state.table(), plan_id, ps.Change({}, ps.ACTIVE_PLAN_STATUSES + ps.TERMINAL_PLAN_STATUSES,
                                                              add={'model_calls': calls}), now=state.now)
    ps.append_event(plan_state.table(), plan_id, kind, str(state.definitions[step_id].get('title') or step_id),
                    now=state.now, step_id=step_id)
    return {}
