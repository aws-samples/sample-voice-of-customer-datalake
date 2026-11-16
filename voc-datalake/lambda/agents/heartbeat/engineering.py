"""The heartbeat's engineering agents (7.47.00; docs/autonomous-agents.md "Engineering agents").

An engineering agent runs its engineering flow through voc-engineering-start (lambda/engineering/runtime/handler.py
``start_handler``), as the Agents API's Run now does (shared/engineering_agent_runs.py ``start_agent_run``): one active
run per agent, its lock held while the engineering run is live (``active`` or waiting for a person, ``needs_human``).

- **Ready** (``ready``): the module on (``ENGINEERING_AGENTS``), its connection stored and not removed, its language
  and its flow with a monthly budget; otherwise ``not_set_up`` (an agent enabled before its connection was removed).
- **Who it runs as**: the administrator who enabled it (``owner_sub``, ``owner_username``), re-checked in Cognito
  before every start: the account exists, is enabled, is the same person and is still in ``admins``; otherwise
  ``owner_not_admin`` and nothing starts. A directory that cannot answer fails the tick for the agent (closed).
- **The lock** (``heal``): the agent's run names its engineering run (``engineering_run_id``), whose ``META`` the
  heartbeat reads (voc-engineering ``WS#default#RUN#<id>`` / ``META``, its status only): ``done``, ``failed`` and
  ``stopped`` end the agent's run (completed, failed, cancelled) and free the lock; a run whose ``META`` was never
  written ``START_GRACE`` after it was queued (its start died before the write) fails.

Never logs a subject, a name or a goal: ids and counts.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import cache
from typing import Any, Final

from agents import plan_identity
from shared import agents_store as store
from shared import engineering_agent_runs as eng_runs
from shared.aws import get_dynamodb_resource
from shared.engineering_agents import ENGINEERING_TABLE_ENV, engineering_agents_on
from shared.exceptions import ConflictError, ValidationError
from shared.logging import logger
from shared.timestamps import parse_iso

#: How long a queued run may wait for its engineering run's ``META`` (the start answers in at most 30 s).
START_GRACE: Final = timedelta(minutes=15)
#: An engineering run's end, as the agent's run records it.
ENDS: Final[Mapping[str, str]] = {'done': store.RUN_COMPLETED, 'failed': store.RUN_FAILED, 'stopped': store.RUN_CANCELLED}
LIVE: Final = frozenset({'active', 'needs_human'})
#: What a start needs of the invocation: the start's own wait (25 s) and the broker's resolve, with a margin.
TIME_NEEDED_MS: Final = 60_000


class DirectoryUnavailable(Exception):
    """Cognito could not answer whether the agent's owner is still an admin: nothing starts (closed)."""


@dataclass(frozen=True)
class Ready:
    """What a ready engineering agent starts on: its connection's row, its flow's CURRENT row, and voc-agents (where
    its ``github_issue`` trigger reads the issues' claims)."""

    connection: Mapping[str, Any]
    workflow: Mapping[str, Any]
    agents_table: Any = None


def ready(table: Any, agent: Mapping[str, Any]) -> Ready | None:
    """The agent's connection and flow when it can start a run (module doc), None otherwise."""
    settings = agent.get('engineering') or {}
    if not engineering_agents_on() or not settings.get('connection') or not settings.get('language'):
        return None
    if not os.environ.get(eng_runs.START_FUNCTION_ENV):
        return None
    connection = eng_runs.connection_row(table, str(settings['connection']))
    workflow = store.get_workflow(table, str(agent.get('workflow_id') or ''))
    if connection is None or workflow is None or store.is_archived_workflow(workflow):
        return None
    try:
        budgeted = eng_runs.stored_flow(workflow).budget_usd is not None
    except (ValidationError, ConflictError):   # (an agents workflow, a budget off its rule: not set up)
        return None
    return Ready(connection, workflow, table) if budgeted else None


def owner_is_admin(agent: Mapping[str, Any]) -> bool:
    """The administrator the agent runs as is one now: their account exists, is enabled, is the same person (its
    ``sub``) and is in ``admins`` (a plan approver's re-check, agents/plan_identity.py ``is_current_admin``)."""
    sub, username = agent.get('owner_sub'), agent.get('owner_username')
    if not isinstance(sub, str) or not sub or not isinstance(username, str) or not username:
        return False
    try:
        return plan_identity.is_current_admin(sub, username)
    except plan_identity.DirectoryUnavailable as exc:
        raise DirectoryUnavailable(str(exc)) from exc


def _meta_status(run_id: str) -> str | None:
    """The engineering run's status (its ``META``'s), None when it has none."""
    table = get_dynamodb_resource().Table(os.environ[ENGINEERING_TABLE_ENV])
    item = table.get_item(Key={'pk': f'WS#{eng_runs.ENGINEERING_WORKSPACE}#RUN#{run_id}', 'sk': 'META'},
                          ConsistentRead=True, ProjectionExpression='#s', ExpressionAttributeNames={'#s': 'status'}
                          ).get('Item')
    status = item.get('status') if isinstance(item, dict) else None
    return status if isinstance(status, str) else None


def heal(table: Any, agent: Mapping[str, Any], run: Mapping[str, Any], now: datetime) -> bool:
    """True while the agent's engineering run is live (module doc); its end ends the agent's run."""
    agent_id, run_id = agent['agent_id'], str(run['run_id'])
    engineering_run_id = run.get('engineering_run_id')
    status = _meta_status(engineering_run_id) if isinstance(engineering_run_id, str) and \
        os.environ.get(ENGINEERING_TABLE_ENV) else None
    if status in LIVE:
        return True
    if status in ENDS:
        error = None if status == 'done' else f'The engineering run ended {status}'
        if store.finish_run(table, agent_id, run_id, ENDS[status], now=now, error=error) is not None:
            store.append_event(table, agent_id, run_id, 'decision', f'Engineering run {status}', now=now,
                               role='system')
        return False
    queued = parse_iso(run.get('started_at'))
    if queued is not None and now - queued < START_GRACE:
        return True
    store.finish_run(table, agent_id, run_id, store.RUN_FAILED, now=now,
                     error='The engineering run was never written: its start did not finish')
    logger.warning('Engineering agent run without its engineering run failed', extra={'agent_id': agent_id,
                                                                                       'run_id': run_id})
    return False


@cache
def start_client() -> Any:
    """The Lambda client for the start: it waits ``START_READ_TIMEOUT_SECONDS`` and never retries by itself."""
    import boto3
    from botocore.config import Config
    return boto3.client('lambda', config=Config(read_timeout=eng_runs.START_READ_TIMEOUT_SECONDS, connect_timeout=5,
                                                retries={'total_max_attempts': 1}))


def start(table: Any, agent: Mapping[str, Any], prepared: Ready, start_with: eng_runs.AgentStart,
          now: datetime) -> str:
    """Start the agent's run (``start_agent_run``); the tick's outcome for the agent."""
    if not owner_is_admin(agent):
        store.set_agent_attributes(table, agent['agent_id'], {'last_skip_reason': 'owner_not_admin'})
        return 'owner_not_admin'
    try:
        started = eng_runs.start_agent_run(table, agent, prepared.workflow, prepared.connection, start_with,
                                           client=start_client(), function=os.environ[eng_runs.START_FUNCTION_ENV],
                                           now=now)
    except store.IssueClaimed:
        return 'issue_claimed'   # (another tick or agent took the issue meanwhile: the next tick takes the next one)
    if started.run is None or started.answer is None:
        return 'lock_or_cap'
    logger.info('Engineering agent run', extra={'agent_id': agent['agent_id'], 'run_id': started.run['run_id'],
                                                'trigger': start_with.trigger, 'outcome': started.answer.outcome})
    return 'started' if started.answer.outcome in ('started', 'uncertain') else 'start_refused'
