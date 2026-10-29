"""The ``voc-agents`` table as the runtime sees it.

Row shapes (the shared contract):

- agent:      ``pk=AGENT#{agent_id}``, ``sk=META``
- workflow:   ``pk=WORKFLOW#{workflow_id}``, ``sk=CURRENT`` (pointer) / ``REV#{revision:06d}``
- run:        ``pk=AGENT#{agent_id}``, ``sk=RUN#{run_id}``; ``gsi1pk=RUNS_ACTIVE`` while running
- events:     ``pk=RUN#{run_id}``, ``sk=EVT#{seq:08d}``
- transcript: ``pk=RUN#{run_id}``, ``sk=MATE#{role}#{seq:06d}``

The agent's run lock (``active_run_id``), its per-status run counters and its
month model-call counter (``month_key``/``month_calls``) are owned by
``shared.agents_store`` — the API and heartbeat read them — and this module
writes them only through that module.

Runtime-owned attributes on the run row: ``context`` (what earlier nodes
produced), ``loop_rounds``, ``steps``, ``poll_attempts``, ``event_seq``,
``mate_seq``, ``workflow_revision``. Only the run's own Step Functions
execution writes them; every write is conditional on the run still RUNNING,
so a cancel (status written by the agents API) stops the runtime at its next
step.

Nothing here logs row content: statements, prompts and documents stay out of
CloudWatch.
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from boto3.dynamodb.conditions import Key

from agents.failure_reason import reason_text
from shared import agent_run_decisions
from shared import agents_store as shared_store
from shared.agents_store import (
    RUN_CANCELLED,
    RUN_COMPLETED,
    RUN_FAILED,
    RUN_NEEDS_HUMAN,
    RUN_QUEUED,
    RUN_RUNNING,
    RUNS_ACTIVE_GSI_PK,
)
from shared.aws import get_dynamodb_resource, is_conditional_check_failure
from shared.dynamo_values import plain
from shared.timestamps import now_iso

TERMINAL_STATUSES = frozenset({RUN_NEEDS_HUMAN, RUN_COMPLETED, RUN_FAILED, RUN_CANCELLED})

EVENT_KINDS = frozenset({
    'node_started', 'node_finished', 'node_failed', 'message', 'verdict', 'decision', 'artifact',
})
MAX_EVENT_SUMMARY_CHARS = 500
MAX_MATE_TEXT_CHARS = 8000


class RunNotRunning(Exception):
    """The run left RUNNING (cancelled, or finished elsewhere) under our feet."""


class BudgetExhausted(Exception):
    """The run has spent its model-call budget."""


def dynamo_value(value: Any) -> Any:
    """The inverse of ``plain`` for writes: floats become Decimal (DynamoDB rejects float)."""
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {str(k): dynamo_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [dynamo_value(v) for v in value]
    return value


def _table():
    name = os.environ.get('AGENTS_TABLE', '')
    if not name:
        raise RuntimeError('AGENTS_TABLE is not configured')
    return get_dynamodb_resource().Table(name)


def get_agent(agent_id: str) -> dict | None:
    item = _table().get_item(Key={'pk': f'AGENT#{agent_id}', 'sk': 'META'}, ConsistentRead=True).get('Item')
    return plain(item) if isinstance(item, dict) else None


def get_run(agent_id: str, run_id: str) -> dict | None:
    item = _table().get_item(Key=shared_store.run_key(agent_id, run_id), ConsistentRead=True).get('Item')
    return plain(item) if isinstance(item, dict) else None


def _definition_of(item: dict | None) -> dict | None:
    raw = item.get('definition') if isinstance(item, dict) else None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return None
    return plain(raw) if isinstance(raw, dict) else None


def load_workflow(workflow_id: str, revision: int | None = None) -> tuple[dict, int] | None:
    """``(definition, revision)`` — the pinned revision, else the CURRENT one."""
    table = _table()
    pk = f'WORKFLOW#{workflow_id}'
    if revision is None:
        pointer = table.get_item(Key={'pk': pk, 'sk': 'CURRENT'}, ConsistentRead=True).get('Item')
        if not isinstance(pointer, dict):
            return None
        revision = int(plain(pointer.get('revision') or 0))
        inline = _definition_of(pointer)
        if inline is not None and revision:
            return inline, revision
    item = table.get_item(Key={'pk': pk, 'sk': f'REV#{revision:06d}'}, ConsistentRead=True).get('Item')
    definition = _definition_of(item)
    return (definition, revision) if definition is not None else None


def start_run(agent_id: str, run_id: str, workflow_revision: int) -> dict:
    """queued → running (idempotent for a redriven execution)."""
    try:
        response = _table().update_item(
            Key=shared_store.run_key(agent_id, run_id),
            UpdateExpression=(
                'SET #status = :running, started_at = if_not_exists(started_at, :now), '
                'gsi1pk = :active, gsi1sk = :now, workflow_revision = :rev, '
                '#context = if_not_exists(#context, :empty), '
                'loop_rounds = if_not_exists(loop_rounds, :empty), '
                'steps = if_not_exists(steps, :zero), '
                'model_calls = if_not_exists(model_calls, :zero)'
            ),
            ConditionExpression='attribute_exists(pk) AND #status IN (:queued, :running)',
            ExpressionAttributeNames={'#status': 'status', '#context': 'context'},
            ExpressionAttributeValues={
                ':running': RUN_RUNNING, ':queued': RUN_QUEUED, ':now': now_iso(),
                ':active': RUNS_ACTIVE_GSI_PK, ':rev': workflow_revision, ':empty': {}, ':zero': 0,
            },
            ReturnValues='ALL_NEW',
        )
    except Exception as exc:
        if is_conditional_check_failure(exc):
            raise RunNotRunning('run is not queued') from exc
        raise
    _record_last_run_running(agent_id, run_id)
    return plain(response['Attributes'])


def _record_last_run_running(agent_id: str, run_id: str) -> None:
    """The agent's ``last_run_status`` follows its run from queued to running.

    Without it the agents list (which reads only the agent row) said "Queued" for a
    run that had been working for an hour. Conditional on this run still being the
    agent's last one and still recorded as queued, so it never writes over a newer
    run or a finish that landed first.
    """
    try:
        _table().update_item(
            Key={'pk': f'AGENT#{agent_id}', 'sk': 'META'},
            UpdateExpression='SET last_run_status = :running',
            ConditionExpression='last_run_id = :run AND last_run_status = :queued',
            ExpressionAttributeValues={':run': run_id, ':running': RUN_RUNNING, ':queued': RUN_QUEUED},
        )
    except Exception as exc:
        if not is_conditional_check_failure(exc):
            raise


def update_running(agent_id: str, run_id: str, sets: dict[str, Any], *, remove: tuple[str, ...] = ()) -> None:
    """SET each attribute in ``sets`` (and REMOVE each one in ``remove``) while the run is still RUNNING."""
    if not sets and not remove:
        return
    names = {'#status': 'status'}
    values: dict[str, Any] = {':running': RUN_RUNNING}
    parts = []
    for index, (attribute, value) in enumerate(sets.items()):
        names[f'#a{index}'] = attribute
        values[f':v{index}'] = dynamo_value(value)
        parts.append(f'#a{index} = :v{index}')
    for index, attribute in enumerate(remove):
        names[f'#r{index}'] = attribute
    expression = ('SET ' + ', '.join(parts)) if parts else ''
    if remove:
        expression += (' ' if expression else '') + 'REMOVE ' + ', '.join(f'#r{i}' for i in range(len(remove)))
    try:
        _table().update_item(
            Key=shared_store.run_key(agent_id, run_id),
            UpdateExpression=expression,
            ConditionExpression='#status = :running',
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except Exception as exc:
        if is_conditional_check_failure(exc):
            raise RunNotRunning('run left running') from exc
        raise


def finish_run(agent_id: str, run_id: str, status: str, error: str | None = None,
               needs_human: Mapping[str, Any] | None = None) -> bool:
    """running → terminal. False when the run had already left RUNNING.

    A ``needs_human`` finish writes its payload in the SAME update (no second write
    can race a human's decision) and drops any earlier decision, so the human may
    decide again on this new stop.
    """
    if status not in TERMINAL_STATUSES:
        raise ValueError(f'not a terminal status: {status}')
    now = now_iso()
    names = {'#status': 'status'}
    values: dict[str, Any] = {':status': status, ':now': now, ':running': RUN_RUNNING}
    sets = ['#status = :status', 'finished_at = :now']
    removes = ['gsi1pk', 'gsi1sk', 'resume']
    if error:
        names['#error'] = 'error'
        values[':error'] = error[:MAX_EVENT_SUMMARY_CHARS]
        sets.append('#error = :error')
    if needs_human is not None:
        values[':needs_human'] = dynamo_value(dict(needs_human))
        sets.append('needs_human = :needs_human')
        removes.append('decision')
    try:
        _table().update_item(
            Key=shared_store.run_key(agent_id, run_id),
            UpdateExpression=f"SET {', '.join(sets)} REMOVE {', '.join(removes)}",
            ConditionExpression='#status = :running',
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except Exception as exc:
        if is_conditional_check_failure(exc):
            return False
        raise
    # The run lock and the per-status counters belong to the agents API's store;
    # without this release the agent's NEXT run (manual or scheduled) is refused.
    shared_store.release_lock(_table(), agent_id, run_id, status)
    _record_last_run(agent_id, run_id, status)
    return True


def mark_cancelled_finished(agent_id: str, run_id: str) -> None:
    """A cancelled run: stamp finished_at and leave the active index (status untouched)."""
    try:
        _table().update_item(
            Key=shared_store.run_key(agent_id, run_id),
            UpdateExpression='SET finished_at = if_not_exists(finished_at, :now) REMOVE gsi1pk, gsi1sk',
            ConditionExpression='#status = :cancelled',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':now': now_iso(), ':cancelled': RUN_CANCELLED},
        )
    except Exception as exc:
        if not is_conditional_check_failure(exc):
            raise


def _record_last_run(agent_id: str, run_id: str, status: str) -> None:
    try:
        _table().update_item(
            Key={'pk': f'AGENT#{agent_id}', 'sk': 'META'},
            UpdateExpression='SET last_run_id = :run, last_run_status = :status',
            ConditionExpression='attribute_exists(pk)',
            ExpressionAttributeValues={':run': run_id, ':status': status},
        )
    except Exception as exc:
        if not is_conditional_check_failure(exc):
            raise


def _counter_value(value: object) -> int:
    """An ``UPDATED_NEW`` counter attribute (a ``Decimal`` from the resource API) as an int."""
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise TypeError(f'counter attribute is not a number: {type(value).__name__}')
    return int(value)


def _next_seq(agent_id: str, run_id: str, counter: str) -> int:
    response = _table().update_item(
        Key=shared_store.run_key(agent_id, run_id),
        UpdateExpression='ADD #counter :one',
        ConditionExpression='attribute_exists(pk)',
        ExpressionAttributeNames={'#counter': counter},
        ExpressionAttributeValues={':one': 1},
        ReturnValues='UPDATED_NEW',
    )
    return _counter_value(response['Attributes'][counter])


def append_event(agent_id: str, run_id: str, kind: str, summary: str, *,
                 node_id: str | None = None, role: str | None = None,
                 ref: Mapping[str, object] | None = None, detail: object = None) -> int:
    """Journal one event. ``summary`` is for people; ``detail`` (masked, one line) is the technical log."""
    if kind not in EVENT_KINDS:
        raise ValueError(f'unknown event kind: {kind}')
    seq = _next_seq(agent_id, run_id, 'event_seq')
    item: dict[str, Any] = {
        'pk': f'RUN#{run_id}', 'sk': f'EVT#{seq:08d}', 'seq': seq, 'at': now_iso(),
        'kind': kind, 'summary': (summary or '')[:MAX_EVENT_SUMMARY_CHARS],
    }
    if node_id:
        item['node_id'] = node_id
    if role:
        item['role'] = role
    technical = reason_text(detail)
    if technical:
        item['detail'] = technical
    clean_ref = {k: v for k, v in (ref or {}).items() if isinstance(v, str) and v}
    if clean_ref:
        item['ref'] = clean_ref
    _table().put_item(Item=item)
    return seq


def list_events(run_id: str, limit: int) -> list[dict]:
    """The run's journal, oldest first (at most ``limit`` events)."""
    response = _table().query(
        KeyConditionExpression=Key('pk').eq(f'RUN#{run_id}') & Key('sk').begins_with('EVT#'),
        Limit=limit,
    )
    return [plain(item) for item in response.get('Items', [])]


def append_mate(agent_id: str, run_id: str, role: str, node_id: str, direction: str, text: str) -> int:
    """One crewmate transcript row. ``direction`` is 'to_mate' or 'from_mate'."""
    seq = _next_seq(agent_id, run_id, 'mate_seq')
    _table().put_item(Item={
        'pk': f'RUN#{run_id}', 'sk': f'MATE#{role}#{seq:06d}', 'seq': seq, 'at': now_iso(),
        'role': role, 'node_id': node_id, 'direction': direction,
        'text': (text or '')[:MAX_MATE_TEXT_CHARS],
    })
    return seq


def get_mate(run_id: str, role: str, seq: int) -> dict | None:
    item = _table().get_item(Key={'pk': f'RUN#{run_id}', 'sk': f'MATE#{role}#{seq:06d}'}).get('Item')
    return plain(item) if isinstance(item, dict) else None


def reserve_model_call(agent: dict, run_id: str, max_calls: int) -> int:
    """Atomically take one model call from the run's budget, or raise BudgetExhausted.

    Reserved BEFORE the call, so concurrent persona calls can never overshoot.
    The agent's month counter (``month_calls`` on META) is bumped too; the
    heartbeat enforces the monthly cap from it. A resumed run carries its own
    ``call_ceiling`` (spent calls + a fresh budget, shared/agent_run_resume.py),
    which replaces ``max_calls`` while it is set.
    """
    table = _table()
    try:
        response = table.update_item(
            Key=shared_store.run_key(agent['agent_id'], run_id),
            UpdateExpression='SET model_calls = if_not_exists(model_calls, :zero) + :one',
            ConditionExpression=(
                '#status = :running AND (attribute_not_exists(model_calls) '
                'OR (attribute_exists(call_ceiling) AND model_calls < call_ceiling) '
                'OR (attribute_not_exists(call_ceiling) AND model_calls < :max))'
            ),
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues={':zero': 0, ':one': 1, ':max': max_calls, ':running': RUN_RUNNING},
            ReturnValues='UPDATED_NEW',
        )
    except Exception as exc:
        if is_conditional_check_failure(exc):
            raise BudgetExhausted('model-call budget exhausted or run not running') from exc
        raise
    shared_store.count_month_calls(table, agent, 1, now=datetime.now(UTC))
    return _counter_value(response['Attributes']['model_calls'])


#: Public web searches one run may execute, across all of its steps (owner decision
#: 2026-10-17: agent steps search the web by default, capped per run). Counted on the
#: RUN row as ``web_queries``, beside ``model_calls``.
MAX_WEB_QUERIES_PER_RUN = 10


def reserve_web_queries(agent: dict, run_id: str, wanted: int) -> int:
    """Take up to ``wanted`` web searches from the run's budget; the number granted (0..wanted).

    Optimistic: the grant is written with a condition on the count it was computed
    from, so two concurrent steps can never overshoot — the loser is granted 0 and
    runs without the web. Reserved searches are not refunded when fewer run.
    """
    run = get_run(agent['agent_id'], run_id) or {}
    used = _counter_value(run.get('web_queries', 0))
    grant = max(0, min(int(wanted), MAX_WEB_QUERIES_PER_RUN - used))
    if grant == 0 or run.get('status') != RUN_RUNNING:
        return 0
    unchanged = 'attribute_not_exists(web_queries)' if 'web_queries' not in run else 'web_queries = :used'
    values: dict[str, Any] = {':grant': grant, ':running': RUN_RUNNING, ':zero': 0}
    if 'web_queries' in run:
        values[':used'] = used
    try:
        _table().update_item(
            Key=shared_store.run_key(agent['agent_id'], run_id),
            UpdateExpression='SET web_queries = if_not_exists(web_queries, :zero) + :grant',
            ConditionExpression=f'#status = :running AND {unchanged}',
            ExpressionAttributeNames={'#status': 'status'},
            ExpressionAttributeValues=values,
        )
    except Exception as exc:
        if is_conditional_check_failure(exc):
            return 0
        raise
    return grant


def max_calls_for(agent: dict) -> int:
    return agent_run_decisions.max_calls_per_run(agent)
