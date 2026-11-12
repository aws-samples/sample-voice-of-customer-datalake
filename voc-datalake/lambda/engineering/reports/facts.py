"""What a report says about its run, read from the ``voc-engineering`` table (the record, I6), never from events.

- ``META``: the run's goal, repository, flow, status and times (the run's start and end write them).
- ``AGENT#<agent>``: each agent's role, skill version and model (CHANGE 3: every report names the versions that made
  it) and its metering, which the runtime and the brokers add to (MicroVM-seconds, tokens, the cost they priced).
- ``MSG#``: the conversation, counted (the events of the run).

A missing attribute reads as empty or zero: a report of a run still under way says what is known so far.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from engineering.rows import count_run_rows, run_pk, run_rows


@dataclass(frozen=True)
class AgentFacts:
    agent: str
    role: str
    skill_version: str
    model: str
    microvm_seconds: int
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal


@dataclass(frozen=True)
class RunFacts:
    ws: str
    run_id: str
    goal: str
    repo: str
    flow: str
    status: str
    started_at: str
    ended_at: str
    agents: tuple[AgentFacts, ...]
    events: int


def _s(item: Mapping[str, Any], key: str) -> str:
    return str(item.get(key, {}).get('S', ''))


def _n(item: Mapping[str, Any], key: str) -> Decimal:
    try:
        value = Decimal(str(item.get(key, {}).get('N', '0')))
    except InvalidOperation:
        return Decimal(0)
    return value if value.is_finite() and value >= 0 else Decimal(0)


class FactsReader:
    def __init__(self, client: Any, table: str) -> None:
        """``client`` is a low-level DynamoDB client."""
        self.client = client
        self.table = table

    def read(self, ws: str, run_id: str) -> RunFacts | None:
        """The run's facts, or None when the run does not exist."""
        meta = self.client.get_item(TableName=self.table, Key={'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}},
                                    ConsistentRead=True).get('Item')
        if meta is None:
            return None
        agent_rows = run_rows(self.client, self.table, ws, run_id, 'AGENT#')
        events = count_run_rows(self.client, self.table, ws, run_id, 'MSG#')
        agents = tuple(sorted((AgentFacts(
            agent=_s(row, 'sk').removeprefix('AGENT#'), role=_s(row, 'role'), skill_version=_s(row, 'skill_version'),
            model=_s(row, 'model'), microvm_seconds=int(_n(row, 'microvm_seconds')),
            input_tokens=int(_n(row, 'input_tokens')), output_tokens=int(_n(row, 'output_tokens')),
            cost_usd=_n(row, 'cost_usd')) for row in agent_rows), key=lambda agent: agent.agent))
        return RunFacts(ws=ws, run_id=run_id, goal=_s(meta, 'goal'), repo=_s(meta, 'repo'), flow=_s(meta, 'flow'),
                        status=_s(meta, 'status'), started_at=_s(meta, 'started_at'), ended_at=_s(meta, 'ended_at'),
                        agents=agents, events=events)
