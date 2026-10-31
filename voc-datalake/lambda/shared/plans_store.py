"""Plan mode: the ``voc-agents`` rows of an approved ``voc-plan/1`` plan (docs/assistant-plan-mode.md).

Shared by the agents API (``api/agents_handler.py``: approve a plan, read it, cancel it, resolve a
paused step) and the conductor (``agents/conductor/plan.py``: walk it), so both read and write the
same rows the same way.

Rows (``voc-agents``):

- plan   ``PLAN#{plan_id}`` / ``META``: the approved plan (``plan_json``, canonical), its
         ``fingerprint`` (sha256 of the canonical JSON), the approver (``approver_sub`` +
         ``approver_username``, never returned by a view), ``status``, ``conversation_id``,
         ``created_at``/``started_at``/``finished_at``, ``model_calls``, ``event_seq``, ``summary``.
         ``gsi1pk=PLANS#{approver_sub}``, ``gsi1sk={created_at}#{plan_id}`` on the existing
         ``gsi1-by-agents-listing`` index: the caller's plans, newest first (no new GSI).
- step   ``PLAN#{plan_id}`` / ``STEP#{step_id}``: ``index`` (plan order), ``kind``, ``pack``,
         ``title``, ``after``, ``status``, ``outputs`` (name → text), ``error``, ``pending_json``
         (a write waiting for the approver) with its ``pending_fingerprint`` (the approve route is
         conditional on it: the approver approves exactly the write their card showed),
         ``approved_pending_json`` (the write the approver accepted), ``fingerprint`` (of the
         executed write), timestamps.
- event  ``PLAN#{plan_id}`` / ``EVT#{seq:08d}``: the journal, like a run's ``RUN#…/EVT#…``.
- cap    ``PLANCAP#{approver_sub}`` / ``META``: ``active``, the approver's plans that hold a slot. Creating
         a plan adds 1 in the SAME transaction as its rows, on the condition ``active < MAX_ACTIVE_PLANS``
         (so concurrent approvals can never pass the cap); every terminal transition of a plan whose
         META has ``holds_slot`` subtracts 1 in the same transaction as that transition.

Every transition is a conditional write on the row's current status, so the API (cancel,
approve, decline) and the runtime (start, record, finish) can never write over each other.
Nothing here logs a subject, an e-mail, a goal or an argument: ids and counts only.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Final

from boto3.dynamodb.conditions import Key
from botocore.exceptions import BotoCoreError, ClientError

from shared import agents_store
from shared.agents_store import AGENTS_INDEX, META_SK, iso
from shared.aws import is_conditional_check_failure
from shared.dynamo_paging import iter_query
from shared.dynamo_values import plain
from shared.exceptions import ServiceError
from shared.logging import logger
from shared.plan_canonical import canonical_json
from shared.plan_schema import PLAN_LIMITS, PLAN_STATUSES, PLAN_STEP_STATUSES
from shared.timestamps import parse_iso

STEP_SK_PREFIX: Final = 'STEP#'
EVENT_SK_PREFIX: Final = 'EVT#'
CALLER_INDEX_PREFIX: Final = 'PLANS#'
CAP_PREFIX: Final = 'PLANCAP#'
# Plans one user may have approved and not yet finished at once (a 409 beyond that).
MAX_ACTIVE_PLANS: Final = 3

PLAN_APPROVED: Final = 'approved'
PLAN_RUNNING: Final = 'running'
PLAN_COMPLETED: Final = 'completed'
PLAN_COMPLETED_WITH_ERRORS: Final = 'completed_with_errors'
PLAN_FAILED: Final = 'failed'
PLAN_CANCELLED: Final = 'cancelled'
PLAN_EXPIRED: Final = 'expired'
ACTIVE_PLAN_STATUSES: Final = (PLAN_APPROVED, PLAN_RUNNING)
TERMINAL_PLAN_STATUSES: Final = (PLAN_COMPLETED, PLAN_COMPLETED_WITH_ERRORS, PLAN_FAILED, PLAN_CANCELLED,
                                 PLAN_EXPIRED)

STEP_PENDING: Final = 'pending'
STEP_RUNNING: Final = 'running'
STEP_WAITING: Final = 'waiting'
STEP_DONE: Final = 'done'
STEP_FAILED: Final = 'failed'
STEP_SKIPPED: Final = 'skipped'
STEP_NEEDS_APPROVAL: Final = 'needs_approval'
STEP_CANCELLED: Final = 'cancelled'
OPEN_STEP_STATUSES: Final = (STEP_PENDING, STEP_WAITING, STEP_NEEDS_APPROVAL)
FINISHED_STEP_STATUSES: Final = (STEP_DONE, STEP_FAILED, STEP_SKIPPED, STEP_CANCELLED)

# An approved plan that has not started by then never will (PLAN_LIMITS.startTtlHours).
START_TTL: Final = timedelta(hours=PLAN_LIMITS['startTtlHours'])
# A stored output feeds later steps (a think step's text may fill a {{free}} field); a view shows less.
MAX_STORED_OUTPUT_CHARS: Final = 8000
MAX_VIEW_OUTPUT_CHARS: Final = 500
MAX_ERROR_CHARS: Final = 500
MAX_SUMMARY_CHARS: Final = 2000
MAX_EVENT_SUMMARY_CHARS: Final = 500
DEFAULT_LIST_LIMIT: Final = 20
MAX_LIST_LIMIT: Final = 50

DECLINED_ERROR: Final = 'Declined by the approver.'
STEP_CHANGED_ERROR: Final = 'This step changed; review it again'
# The paused write's attributes, removed together once it is resolved.
PENDING_FIELDS: Final = ('pending_json', 'pending_fingerprint', 'pending_since')
CANCELLED_ERROR: Final = 'The plan was cancelled.'


@dataclass(frozen=True)
class Approver:
    """The signed-in user who approved the plan; the plan runs as them (``voc:acting_subject``)."""

    sub: str
    username: str


def _check_statuses() -> None:
    """The statuses named here are exactly the contract's (``plan_contract.json``)."""
    plan = {*ACTIVE_PLAN_STATUSES, *TERMINAL_PLAN_STATUSES}
    steps = {STEP_RUNNING, *OPEN_STEP_STATUSES, *FINISHED_STEP_STATUSES}
    if not plan <= set(PLAN_STATUSES) or steps != set(PLAN_STEP_STATUSES):
        raise RuntimeError('plans_store statuses disagree with plan_contract.json')


_check_statuses()


# --------------------------------------------------------------------------
# Ids, keys, fingerprint.
# --------------------------------------------------------------------------

def new_plan_id() -> str:
    """``pl_<12 hex>`` (``plan_schema.is_plan_id``); never an agent id (``ag_…``)."""
    return f'pl_{secrets.token_hex(6)}'


def plan_key(plan_id: str) -> dict[str, str]:
    return {'pk': f'PLAN#{plan_id}', 'sk': META_SK}


def step_key(plan_id: str, step_id: str) -> dict[str, str]:
    return {'pk': f'PLAN#{plan_id}', 'sk': f'{STEP_SK_PREFIX}{step_id}'}


def cap_key(sub: str) -> dict[str, str]:
    return {'pk': f'{CAP_PREFIX}{sub}', 'sk': META_SK}


def plan_fingerprint(plan: Mapping[str, Any]) -> str:
    """sha256 hex of the plan's canonical JSON: what the approver approved, byte for byte."""
    return hashlib.sha256(canonical_json(plan).encode('utf-8')).hexdigest()


def _service_error(what: str, exc: Exception) -> ServiceError:
    logger.exception(f'Plans store: {what} failed', extra={'error_type': type(exc).__name__})  # noqa: LOG004 — only called from an except handler, which supplies the traceback
    return ServiceError(f'Could not {what}. Please retry.')


def clip(value: object, limit: int) -> str:
    text = value if isinstance(value, str) else str(value)
    return text[:limit]


# --------------------------------------------------------------------------
# Create and read.
# --------------------------------------------------------------------------

def _step_row(plan_id: str, index: int, step: Mapping[str, Any]) -> dict[str, Any]:
    return {
        **step_key(plan_id, step['id']), 'plan_id': plan_id, 'step_id': step['id'], 'index': index,
        'kind': step['kind'], 'pack': step['pack'], 'title': step['title'],
        'after': list(step.get('after') or []), 'status': STEP_PENDING, 'outputs': {},
    }


class PlanCapReached(Exception):
    """The approver already has MAX_ACTIVE_PLANS plans that have not finished."""


def _take_slot(table: Any, sub: str, stamp: str) -> dict:
    """The transaction item that takes one of the approver's MAX_ACTIVE_PLANS slots (or cancels it all)."""
    return {'Update': {
        'TableName': table.name, 'Key': cap_key(sub),
        'UpdateExpression': 'ADD #active :one SET #updated = :now',
        'ConditionExpression': 'attribute_not_exists(#active) OR #active < :max',
        'ExpressionAttributeNames': {'#active': 'active', '#updated': 'updated_at'},
        'ExpressionAttributeValues': {':one': 1, ':max': MAX_ACTIVE_PLANS, ':now': stamp},
    }}


def _cap_refused(exc: ClientError) -> bool:
    """The create transaction was cancelled by its first item, the slot condition."""
    reasons = exc.response.get('CancellationReasons') or []
    return bool(reasons) and (reasons[0] or {}).get('Code') == 'ConditionalCheckFailed'


def create_plan(table: Any, plan: Mapping[str, Any], *, approver: Approver, conversation_id: str | None,
                now: datetime) -> dict:
    """Store an approved plan and its steps in one transaction that also takes one of the approver's
    slots; the META row. PlanCapReached when MAX_ACTIVE_PLANS of theirs are still active."""
    plan_id, stamp = new_plan_id(), iso(now)
    meta: dict[str, Any] = {
        **plan_key(plan_id), 'plan_id': plan_id, 'status': PLAN_APPROVED, 'goal': plan['goal'],
        'plan_json': canonical_json(plan), 'fingerprint': plan_fingerprint(plan),
        'approver_sub': approver.sub, 'approver_username': approver.username,
        'created_at': stamp, 'updated_at': stamp, 'model_calls': 0, 'event_seq': 0,
        'step_count': len(plan['steps']), 'holds_slot': True,
        'gsi1pk': f'{CALLER_INDEX_PREFIX}{approver.sub}', 'gsi1sk': f'{stamp}#{plan_id}',
    }
    if conversation_id:
        meta['conversation_id'] = conversation_id
    rows = [meta, *(_step_row(plan_id, index, step) for index, step in enumerate(plan['steps']))]
    try:
        table.meta.client.transact_write_items(TransactItems=[_take_slot(table, approver.sub, stamp), *(
            {'Put': {'TableName': table.name, 'Item': row, 'ConditionExpression': 'attribute_not_exists(pk)'}}
            for row in rows
        )])
    except ClientError as exc:
        if _cap_refused(exc):
            raise PlanCapReached(f'You already have {MAX_ACTIVE_PLANS} plans running; '
                                 'wait for one to finish or cancel it') from exc
        raise _service_error('store the plan', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('store the plan', exc) from exc
    return meta


def _get(table: Any, key: Mapping[str, str], what: str) -> dict | None:
    try:
        item = table.get_item(Key=dict(key), ConsistentRead=True).get('Item')
    except (ClientError, BotoCoreError) as exc:
        raise _service_error(what, exc) from exc
    return plain(item) if isinstance(item, dict) else None


def get_meta(table: Any, plan_id: str) -> dict | None:
    return _get(table, plan_key(plan_id), 'read the plan')


def get_step(table: Any, plan_id: str, step_id: str) -> dict | None:
    return _get(table, step_key(plan_id, step_id), 'read the plan step')


def get_steps(table: Any, plan_id: str) -> list[dict]:
    """Every step row of the plan, in plan order."""
    kwargs: dict[str, Any] = {
        'KeyConditionExpression': Key('pk').eq(f'PLAN#{plan_id}') & Key('sk').begins_with(STEP_SK_PREFIX),
        'ConsistentRead': True,
    }
    try:
        items = [plain(item) for item in iter_query(table, kwargs)]
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('read the plan steps', exc) from exc
    return sorted(items, key=lambda row: int(row.get('index') or 0))


def stored_plan(meta: Mapping[str, Any]) -> dict[str, Any]:
    """The approved ``voc-plan/1`` document."""
    value = json.loads(str(meta.get('plan_json') or '{}'))
    return value if isinstance(value, dict) else {}


def plan_steps_by_id(meta: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return {step['id']: step for step in stored_plan(meta).get('steps') or [] if isinstance(step, dict)}


def list_plans(table: Any, sub: str, *, limit: int) -> list[dict]:
    """The caller's newest plans (META rows) from the caller index."""
    try:
        page = table.query(
            IndexName=AGENTS_INDEX, KeyConditionExpression=Key('gsi1pk').eq(f'{CALLER_INDEX_PREFIX}{sub}'),
            ScanIndexForward=False, Limit=limit,
        )
    except (ClientError, BotoCoreError) as exc:
        raise _service_error('list your plans', exc) from exc
    return [plain(item) for item in page.get('Items', [])]


# --------------------------------------------------------------------------
# Conditional transitions.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Change:
    """One conditional update: SET ``sets``, REMOVE ``remove``, ADD ``add`` — while status ∈ ``when``
    and every ``match`` attribute equals its value."""

    sets: Mapping[str, Any]
    when: Iterable[str]
    remove: Iterable[str] = ()
    add: Mapping[str, int] | None = None
    match: Mapping[str, Any] | None = None


def _expression(change: Change) -> tuple[str, dict[str, str], dict[str, Any]]:
    names: dict[str, str] = {'#st': 'status'}
    values: dict[str, Any] = {}
    parts: list[str] = []
    for index, (name, value) in enumerate(change.sets.items()):
        names[f'#s{index}'] = name
        values[f':s{index}'] = value
        parts.append(f'#s{index} = :s{index}')
    update = f'SET {", ".join(parts)}' if parts else ''
    removed = [f'#r{index}' for index, _ in enumerate(change.remove)]
    names.update({f'#r{index}': name for index, name in enumerate(change.remove)})
    if removed:
        update += f' REMOVE {", ".join(removed)}'
    added = []
    for index, (name, amount) in enumerate((change.add or {}).items()):
        names[f'#a{index}'] = name
        values[f':a{index}'] = amount
        added.append(f'#a{index} :a{index}')
    if added:
        update += f' ADD {", ".join(added)}'
    return update.strip(), names, values


def _conditional(change: Change) -> tuple[str, str, dict[str, str], dict[str, Any]]:
    """(update, condition, names, values) of one Change."""
    update, names, values = _expression(change)
    allowed = list(change.when)
    values.update({f':w{index}': status for index, status in enumerate(allowed)})
    condition = f'attribute_exists(pk) AND #st IN ({", ".join(f":w{index}" for index in range(len(allowed)))})'
    for index, (name, value) in enumerate((change.match or {}).items()):
        names[f'#m{index}'] = name
        values[f':m{index}'] = value
        condition += f' AND #m{index} = :m{index}'
    return update, condition, names, values


def _apply(table: Any, key: Mapping[str, str], change: Change) -> dict | None:
    """The updated row, or None when the row is missing or not in an allowed status."""
    update, condition, names, values = _conditional(change)
    try:
        return plain(table.update_item(
            Key=dict(key), UpdateExpression=update, ConditionExpression=condition,
            ExpressionAttributeNames=names, ExpressionAttributeValues=values, ReturnValues='ALL_NEW',
        )['Attributes'])
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return None
        raise _service_error('update the plan', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('update the plan', exc) from exc


def update_meta(table: Any, plan_id: str, change: Change, *, now: datetime) -> dict | None:
    return _apply(table, plan_key(plan_id), Change({**change.sets, 'updated_at': iso(now)}, change.when,
                                                   change.remove, change.add, change.match))


def update_step(table: Any, plan_id: str, step_id: str, change: Change, *, now: datetime) -> dict | None:
    touched = {**change.sets, 'updated_at': iso(now)}
    return _apply(table, step_key(plan_id, step_id), Change(touched, change.when, change.remove, change.add,
                                                            change.match))


def finish_step(table: Any, plan_id: str, step_id: str, status: str, *, now: datetime, when: Iterable[str],
                error: str | None = None, outputs: Mapping[str, str] | None = None) -> dict | None:
    """Move a step to a finished status (done / failed / skipped / cancelled)."""
    sets: dict[str, Any] = {'status': status, 'finished_at': iso(now)}
    if error:
        sets['error'] = clip(error, MAX_ERROR_CHARS)
    if outputs is not None:
        sets['outputs'] = dict(outputs)
    return update_step(table, plan_id, step_id, Change(sets, when, remove=PENDING_FIELDS), now=now)


def _release_slot(table: Any, sub: str, stamp: str) -> dict:
    return {'Update': {
        'TableName': table.name, 'Key': cap_key(sub), 'UpdateExpression': 'ADD #active :minus SET #updated = :now',
        'ExpressionAttributeNames': {'#active': 'active', '#updated': 'updated_at'},
        'ExpressionAttributeValues': {':minus': -1, ':now': stamp},
    }}


def _end_plan(table: Any, plan_id: str, sets: Mapping[str, Any], when: Iterable[str], *, now: datetime) -> dict | None:
    """Move an active plan to a terminal status and, in the same transaction, give back its slot.

    The META update is conditional on the status, so of two concurrent finishers exactly one
    succeeds and the slot is returned once. None when the plan was not in ``when``.
    """
    meta = get_meta(table, plan_id)
    allowed = tuple(when)
    if meta is None or meta.get('status') not in allowed:
        return None
    change = Change({**sets, 'updated_at': iso(now)}, allowed, remove=('holds_slot',))
    if not meta.get('holds_slot') or not meta.get('approver_sub'):
        return _apply(table, plan_key(plan_id), change)
    update, condition, names, values = _conditional(change)
    try:
        table.meta.client.transact_write_items(TransactItems=[
            {'Update': {'TableName': table.name, 'Key': plan_key(plan_id), 'UpdateExpression': update,
                        'ConditionExpression': condition, 'ExpressionAttributeNames': names,
                        'ExpressionAttributeValues': values}},
            _release_slot(table, str(meta['approver_sub']), iso(now)),
        ])
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            return None
        raise _service_error('finish the plan', exc) from exc
    except BotoCoreError as exc:
        raise _service_error('finish the plan', exc) from exc
    return get_meta(table, plan_id)


def finish_plan(table: Any, plan_id: str, status: str, *, now: datetime, summary: str) -> dict | None:
    """Move an active plan to a terminal status (its slot given back); None when it already was terminal."""
    return _end_plan(table, plan_id, {'status': status, 'finished_at': iso(now),
                                      'summary': clip(summary, MAX_SUMMARY_CHARS)}, ACTIVE_PLAN_STATUSES, now=now)



def close_open_steps(table: Any, plan_id: str, *, now: datetime, status: str = STEP_CANCELLED,
                     error: str = CANCELLED_ERROR) -> None:
    """Every pending / waiting / paused step → ``status`` (a running step is left to finish)."""
    for step in get_steps(table, plan_id):
        if step.get('status') in OPEN_STEP_STATUSES:
            finish_step(table, plan_id, str(step['step_id']), status, now=now, when=OPEN_STEP_STATUSES, error=error)


def cancel_plan(table: Any, plan_id: str, *, now: datetime) -> dict | None:
    """Cancel an active plan: no new step starts; a running write finishes. None when already terminal."""
    meta = finish_plan(table, plan_id, PLAN_CANCELLED, now=now, summary=CANCELLED_ERROR)
    if meta is not None:
        close_open_steps(table, plan_id, now=now)
    return meta


def hide_plan(table: Any, plan_id: str, *, hidden_by: str, now: datetime) -> dict | None:
    """Take a FINISHED plan off its approver's list (the "Delete" on the Agents page).

    Never a delete: the META, steps and journal are kept (``hidden_at``/``hidden_by``
    record who removed it, and a direct read by id still answers). Leaving the caller
    index is what removes it from ``list_plans``. A finished plan already gave its
    slot back, so the cap is untouched. Idempotent: a second call keeps the first
    ``hidden_at``/``hidden_by``. None while the plan is active (or missing).
    """
    meta = get_meta(table, plan_id)
    if meta is not None and meta.get('hidden_at'):
        return meta  # only a finished plan is ever hidden
    return update_meta(table, plan_id, Change(
        {'hidden_at': iso(now), 'hidden_by': hidden_by}, TERMINAL_PLAN_STATUSES, remove=('gsi1pk', 'gsi1sk'),
    ), now=now)


def expire_if_stale(table: Any, meta: dict, *, now: datetime) -> dict:
    """An approved plan that has not started within START_TTL is ``expired`` (written once, conditionally)."""
    created = parse_iso(meta.get('created_at'))
    if meta.get('status') != PLAN_APPROVED or created is None or now - created < START_TTL:
        return meta
    expired = _end_plan(table, str(meta['plan_id']), {
        'status': PLAN_EXPIRED, 'finished_at': iso(now),
        'summary': 'The plan did not start within 24 hours of its approval.'}, (PLAN_APPROVED,), now=now)
    if expired is None:
        return get_meta(table, str(meta['plan_id'])) or meta
    close_open_steps(table, str(meta['plan_id']), now=now, error='The plan expired before this step ran.')
    return expired


class StepChanged(Exception):
    """The paused write is no longer the one the approver reviewed (its fingerprint differs)."""


def approve_step(table: Any, plan_id: str, step_id: str, *, fingerprint: str, now: datetime) -> dict | None:
    """The approver accepts the paused write they reviewed: the step runs again with EXACTLY those arguments.

    ``fingerprint`` is the one the approver's card showed. The update is conditional on it being the
    stored ``pending_fingerprint`` (and on the very ``pending_json`` read here), so a stale card never
    approves a write that replaced it. None when the step is not paused; StepChanged when it is paused
    on a different write.
    """
    step = get_step(table, plan_id, step_id)
    if step is None or step.get('status') != STEP_NEEDS_APPROVAL or not step.get('pending_json'):
        return None
    if step.get('pending_fingerprint') != fingerprint:
        raise StepChanged(STEP_CHANGED_ERROR)
    approved = update_step(table, plan_id, step_id, Change(
        {'status': STEP_PENDING, 'approved_pending_json': step['pending_json']},
        (STEP_NEEDS_APPROVAL,), remove=PENDING_FIELDS,
        match={'pending_fingerprint': fingerprint, 'pending_json': step['pending_json']},
    ), now=now)
    if approved is None:
        current = get_step(table, plan_id, step_id) or {}
        if current.get('status') == STEP_NEEDS_APPROVAL:
            raise StepChanged(STEP_CHANGED_ERROR)
    return approved


def decline_step(table: Any, plan_id: str, step_id: str, *, now: datetime) -> dict | None:
    """The approver refuses the paused write: the step fails, its dependents are skipped."""
    return finish_step(table, plan_id, step_id, STEP_FAILED, now=now, when=(STEP_NEEDS_APPROVAL,),
                       error=DECLINED_ERROR)


def launch_plan(table: Any, meta: Mapping[str, Any], *, now: datetime) -> None:
    """Start ``voc-agent-run`` for an approved plan (``{run_kind: 'plan', plan_id}``, execution name = plan id).

    A duplicate start is refused by Step Functions (the name is taken), which is the idempotency we want.
    On any other failure the plan is failed, so it never sits ``approved`` with no runner.
    """
    plan_id = str(meta['plan_id'])
    try:
        # The agents store owns the one Step Functions client of this Lambda (tests patch it there).
        agents_store.stepfunctions_client().start_execution(
            stateMachineArn=agents_store.state_machine_arn(), name=plan_id,
            input=json.dumps({'run_kind': 'plan', 'plan_id': plan_id}),
        )
    except (ClientError, BotoCoreError) as exc:
        if isinstance(exc, ClientError) and exc.response.get('Error', {}).get('Code') == 'ExecutionAlreadyExists':
            return
        finish_plan(table, plan_id, PLAN_FAILED, now=now, summary='The plan could not be started.')
        raise _service_error('start the plan', exc) from exc
    append_event(table, plan_id, 'plan_started', 'Plan approved and queued', now=now)


def append_event(table: Any, plan_id: str, kind: str, summary: str, *, now: datetime,
                 step_id: str | None = None) -> None:
    """One journal row (best effort: a lost event never stops a plan)."""
    try:
        counter = table.update_item(Key=plan_key(plan_id), UpdateExpression='ADD event_seq :one',
                                    ConditionExpression='attribute_exists(pk)',
                                    ExpressionAttributeValues={':one': 1}, ReturnValues='UPDATED_NEW')
        seq = int(counter['Attributes']['event_seq'])
        item: dict[str, Any] = {'pk': f'PLAN#{plan_id}', 'sk': f'{EVENT_SK_PREFIX}{seq:08d}', 'plan_id': plan_id,
                                'seq': seq, 'at': iso(now), 'kind': kind,
                                'summary': clip(summary, MAX_EVENT_SUMMARY_CHARS)}
        if step_id:
            item['step_id'] = step_id
        table.put_item(Item=item)
    except (ClientError, BotoCoreError, KeyError, TypeError, ValueError):
        logger.warning('Plan event not recorded', extra={'plan_id': plan_id, 'kind': kind})


# --------------------------------------------------------------------------
# Views (never the approver's sub, username or e-mail).
# --------------------------------------------------------------------------

def decode_json(value: object) -> Any:
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except ValueError:
        return None


def _pending_view(step: Mapping[str, Any]) -> dict[str, Any] | None:
    pending = decode_json(step.get('pending_json'))
    if not isinstance(pending, dict) or step.get('status') != STEP_NEEDS_APPROVAL:
        return None
    return {'tool': pending.get('tool'), 'args': pending.get('args'), 'reason': pending.get('reason'),
            'fingerprint': step.get('pending_fingerprint') or pending.get('fingerprint')}


def step_view(step: Mapping[str, Any]) -> dict[str, Any]:
    raw_outputs = step.get('outputs')
    outputs: dict[str, Any] = raw_outputs if isinstance(raw_outputs, dict) else {}
    # A think step's output is its result text (shown in full on the plan card); other outputs are ids.
    limit = MAX_STORED_OUTPUT_CHARS if step.get('kind') == 'think' else MAX_VIEW_OUTPUT_CHARS
    view: dict[str, Any] = {
        'id': step.get('step_id'), 'title': step.get('title'), 'pack': step.get('pack'), 'kind': step.get('kind'),
        'after': list(step.get('after') or []), 'status': step.get('status'),
        'outputs': {str(name): clip(value, limit) for name, value in outputs.items()},
    }
    for name in ('started_at', 'finished_at', 'error'):
        if step.get(name):
            view[name] = step[name]
    pending = _pending_view(step)
    if pending is not None:
        view['pending'] = pending
    return view


def plan_summary_view(meta: Mapping[str, Any]) -> dict[str, Any]:
    return {key: meta.get(key) for key in ('plan_id', 'status', 'goal', 'created_at', 'updated_at')}


def plan_view(meta: Mapping[str, Any], steps: list[dict]) -> dict[str, Any]:
    view = plan_summary_view(meta)
    for name in ('started_at', 'finished_at', 'conversation_id', 'summary'):
        if meta.get(name):
            view[name] = meta[name]
    view['steps'] = [step_view(step) for step in steps]
    return view
