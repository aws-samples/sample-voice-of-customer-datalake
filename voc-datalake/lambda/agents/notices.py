"""Run and plan notices on the ``runs`` channel (shared/realtime.py, docs/realtime.md).

The conductor sends one at each STATUS change it writes, never per journal row of a node:

- an agent run: started (queued → running) and ended (completed / failed / needs_human / cancelled),
  to the agent's owner and to the person who started the run (``requested_by``; the heartbeat is no
  person), as ``{type: 'run', agent_id, run_id, status}``;
- an approved plan: started, a step started / finished / failed, ended, to the plan's approver, as
  ``{type: 'plan', plan_id, change, step_id?}`` (``change`` is the plan journal kind).

A notice carries ids and statuses only; the SPA re-reads through the agents API, which applies the
caller's access as on every poll. Best effort: nothing here raises, and with no Event API configured
nothing is read or sent.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from botocore.exceptions import BotoCoreError, ClientError

from agents import store
from shared import plans_store as ps
from shared import realtime
from shared.agents_store import get_agents_table
from shared.logging import logger

# `requested_by` of a scheduled run (agents/heartbeat/handler.py): no person to tell.
HEARTBEAT_REQUESTER = 'heartbeat'


def _run_recipients(agent: Mapping[str, Any], run: Mapping[str, Any]) -> list[str]:
    found = [agent.get('owner_sub'), run.get('requested_by')]
    subs = [sub for sub in found if isinstance(sub, str) and sub and sub != HEARTBEAT_REQUESTER]
    return list(dict.fromkeys(subs))


def run_changed(agent_id: str, run_id: str, status: str, *,
                agent: Mapping[str, Any] | None = None, run: Mapping[str, Any] | None = None) -> None:
    """An agent run's status changed: tell its owner and its starter."""
    if not realtime.configured() or not agent_id or not run_id:
        return
    try:
        agent = agent if agent is not None else store.get_agent(agent_id) or {}
        run = run if run is not None else store.get_run(agent_id, run_id) or {}
    except (BotoCoreError, ClientError):
        logger.warning('Run notice skipped: the run could not be read', extra={'run_id': run_id})
        return
    event = {'type': 'run', 'agent_id': agent_id, 'run_id': run_id, 'status': status}
    for sub in _run_recipients(agent, run):
        realtime.publish('runs', sub, event)


def plan_changed(plan_id: str, change: str, *, meta: Mapping[str, Any] | None = None,
                 step_id: str | None = None) -> None:
    """A plan or one of its steps changed status: tell the approver."""
    if not realtime.configured() or not plan_id:
        return
    if meta is None:
        table = get_agents_table()
        try:
            meta = ps.get_meta(table, plan_id) if table is not None else None
        except (BotoCoreError, ClientError):
            logger.warning('Plan notice skipped: the plan could not be read', extra={'plan_id': plan_id})
            return
    event: dict[str, Any] = {'type': 'plan', 'plan_id': plan_id, 'change': change}
    if step_id:
        event['step_id'] = step_id
    realtime.publish('runs', (meta or {}).get('approver_sub'), event)
