"""Carry out a human's decision on a ``needs_human`` run (``shared.agent_run_decisions``).

- ``stop``: one conditional update ``needs_human → completed`` that records the
  decision and keeps ``finished_at``; no execution starts.
- ``accept`` / ``another_round``: ONE transaction like ``agents_store.start_run`` —
  the agent row takes the run lock (no other active run, not archived) and the run
  row goes ``needs_human → queued`` with the decision, ``resume = {decision, note}``,
  ``resume_count + 1``, back on the active index and with fresh ceilings so the
  resumed part has its own budget (``call_ceiling`` / ``step_ceiling``, honoured
  by ``agents/store.reserve_model_call`` and the conductor's step check). Then a
  NEW execution ``{run_id}-r{resume_count}`` starts; the conductor's ``init``
  sees ``resume`` and continues from the gate instead of the start.

Both conditions require ``status = needs_human AND attribute_not_exists(decision)``,
so a second decision on the same stop answers None (the route's 409). The
conductor removes ``decision`` whenever it ends a run as needs_human again.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any, Final

from botocore.exceptions import BotoCoreError, ClientError

from shared import agent_run_decisions as decisions
from shared import agents_store as store
from shared.aws import is_conditional_check_failure
from shared.exceptions import ServiceError
from shared.logging import logger

_RECORD_FAILED: Final = 'Could not record the decision. Please retry.'
# Why a resume transaction lost: the agent's lock (another active run, or archived) or the run row.
AGENT_BUSY: Final = 'agent_busy'
RUN_DECIDED: Final = 'run_decided'
_DECIDED_VERBS: Final = {
    decisions.DECISION_ACCEPT: 'accept and continue',
    decisions.DECISION_ANOTHER_ROUND: 'one more round',
}


class ResumeRefused(Exception):
    """The transaction lost: ``reason`` is :data:`AGENT_BUSY` or :data:`RUN_DECIDED`."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def decision_record(decision: str, note: str | None, *, username: str, sub: str, now: datetime) -> dict[str, Any]:
    return {'decision': decision, 'note': note, 'by_username': username, 'by_sub': sub, 'at': store.iso(now)}


def decided_summary(record: Mapping[str, Any]) -> str:
    """The journal line for a decision."""
    note, username = record.get('note'), record.get('by_username') or 'An admin'
    if record['decision'] == decisions.DECISION_STOP:
        text = note or 'no further action'
        return f"Closed by {username}: {text}{'' if text.endswith(('.', '!', '?')) else '.'}"
    base = f"{username} decided: {_DECIDED_VERBS[record['decision']]}"
    return f'{base} — {note}' if note else base


def _record_last_status(table: Any, agent_id: str, run_id: str, status: str) -> None:
    """Stamp the agent's last-run status, unless a newer run already took its place."""
    try:
        table.update_item(Key=store.agent_key(agent_id), UpdateExpression='SET last_run_status = :s',
                          ConditionExpression='last_run_id = :run',
                          ExpressionAttributeValues={':s': status, ':run': run_id})
    except ClientError as exc:
        if not is_conditional_check_failure(exc):
            raise ServiceError(_RECORD_FAILED) from exc
    except BotoCoreError as exc:
        raise ServiceError(_RECORD_FAILED) from exc


def close_run(table: Any, agent_id: str, run_id: str, record: Mapping[str, Any]) -> dict | None:
    """``stop``: needs_human → completed with the decision; None when no longer undecided."""
    try:
        updated = table.update_item(
            Key=store.run_key(agent_id, run_id),
            UpdateExpression='SET #st = :completed, decision = :decision',
            ConditionExpression='attribute_exists(pk) AND #st = :needs_human AND attribute_not_exists(decision)',
            ExpressionAttributeNames={'#st': 'status'},
            ExpressionAttributeValues={':completed': store.RUN_COMPLETED, ':needs_human': store.RUN_NEEDS_HUMAN,
                                       ':decision': dict(record)},
            ReturnValues='ALL_NEW',
        )['Attributes']
    except ClientError as exc:
        if is_conditional_check_failure(exc):
            return None
        raise ServiceError(_RECORD_FAILED) from exc
    except BotoCoreError as exc:
        raise ServiceError(_RECORD_FAILED) from exc
    _record_last_status(table, agent_id, run_id, store.RUN_COMPLETED)
    return updated


def _ceilings(agent: Mapping[str, Any], run: Mapping[str, Any]) -> dict[str, int]:
    calls = int(store.plain(run.get('model_calls')) or 0)
    steps = int(store.plain(run.get('steps')) or 0)
    return {'call_ceiling': calls + decisions.max_calls_per_run(agent),
            'step_ceiling': steps + decisions.MAX_STEPS_PER_RUN}


def _resume_items(table: Any, agent: Mapping[str, Any], run: Mapping[str, Any], record: Mapping[str, Any],
                  count: int, now: datetime) -> list[dict]:
    agent_id, run_id, stamp = agent['agent_id'], run['run_id'], store.iso(now)
    previous = count - 1
    ceilings = _ceilings(agent, run)
    return [
        {'Update': {
            'TableName': table.name, 'Key': store.agent_key(agent_id),
            'UpdateExpression': 'SET active_run_id = :run, last_run_id = :run, last_run_status = :queued',
            'ConditionExpression': 'attribute_exists(pk) AND #status <> :archived AND attribute_not_exists(active_run_id)',
            'ExpressionAttributeNames': {'#status': 'status'},
            'ExpressionAttributeValues': {':run': run_id, ':queued': store.RUN_QUEUED,
                                          ':archived': store.AGENT_STATUS_ARCHIVED},
        }},
        {'Update': {
            'TableName': table.name, 'Key': store.run_key(agent_id, run_id),
            'UpdateExpression': (
                'SET #st = :queued, decision = :decision, resume = :resume, resume_count = :count, '
                'resumed_at = :now, gsi1pk = :active, gsi1sk = :sk, '
                'call_ceiling = :calls, step_ceiling = :steps REMOVE finished_at, #error'
            ),
            'ConditionExpression': (
                'attribute_exists(pk) AND #st = :needs_human AND attribute_not_exists(decision) '
                'AND (attribute_not_exists(resume_count) OR resume_count = :previous)'
            ),
            'ExpressionAttributeNames': {'#st': 'status', '#error': 'error'},
            'ExpressionAttributeValues': {
                ':queued': store.RUN_QUEUED, ':needs_human': store.RUN_NEEDS_HUMAN, ':decision': dict(record),
                ':resume': {'decision': record['decision'], 'note': record.get('note')},
                ':count': count, ':previous': previous, ':now': stamp,
                ':active': store.RUNS_ACTIVE_GSI_PK, ':sk': f'{stamp}#{run_id}',
                ':calls': ceilings['call_ceiling'], ':steps': ceilings['step_ceiling'],
            },
        }},
    ]


def _refusal(exc: ClientError) -> str:
    """Which side of the transaction refused it (the agent lock first)."""
    reasons = exc.response.get('CancellationReasons') or []
    codes = [reason.get('Code') for reason in reasons]
    return AGENT_BUSY if codes[:1] == ['ConditionalCheckFailed'] else RUN_DECIDED


def resume_run(table: Any, agent: Mapping[str, Any], run: Mapping[str, Any], record: Mapping[str, Any], *,
               now: datetime) -> dict:
    """``accept`` / ``another_round``: queue the run again and start its next execution.

    Raises :class:`ResumeRefused` when the lock or the run condition refused the
    transaction, ``ServiceError`` when the execution could not start (the run is
    then failed and the lock freed, like ``agents_store.launch_run``).
    """
    agent_id, run_id = agent['agent_id'], run['run_id']
    count = int(store.plain(run.get('resume_count')) or 0) + 1
    try:
        table.meta.client.transact_write_items(TransactItems=_resume_items(table, agent, run, record, count, now))
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'TransactionCanceledException':
            raise ResumeRefused(_refusal(exc)) from exc
        raise ServiceError('Could not resume the run. Please retry.') from exc
    except BotoCoreError as exc:
        raise ServiceError('Could not resume the run. Please retry.') from exc
    try:
        arn = store.start_execution(run, name=f'{run_id}-r{count}')
    except (ClientError, BotoCoreError) as exc:
        logger.exception('Resumed agent run failed to start', extra={'run_id': run_id})
        store.finish_run(table, agent_id, run_id, store.RUN_FAILED, now=now, error='The run could not be resumed')
        raise ServiceError('Could not resume the agent run. Please retry.') from exc
    store.attach_execution(table, agent_id, run_id, arn)
    resumed = store.get_run(table, agent_id, run_id)
    return dict(resumed) if resumed is not None else {**run, 'execution_arn': arn}
