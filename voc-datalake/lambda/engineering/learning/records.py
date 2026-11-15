"""Reading an ended run's record for its retrospective: its own rows in ``voc-engineering`` and the gate records its
final-go tasks named in the workspace bucket. Nothing else, and never a listing.

- ``META`` (one GetItem): the connection, status and times;
- ``TASK#`` and ``TASKLOG#`` (the board store's reads: one key range each, at most the run's ``max_tasks`` tasks
  and their moves), as the reports read them;
- ``AGENT#`` (one key range): each agent's role, skill version, session seconds, cost, crashes and the
  supervisor's last word on its failure (a launch's hold with no session is not an agent);
- the ``_gate/…/record.json`` objects the final-go tasks recorded as result keys, at most ``MAX_GATE_RECORDS`` (the
  latest attempts first), each checked against the gate's own schema (``GateRecord.from_dict``); one that cannot be
  read or is off it is left out and logged.
"""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from boto3.dynamodb.types import TypeDeserializer

from engineering.board.model import Task
from engineering.board.store import BoardStore
from engineering.flow.ledger import FINAL_GO_ROLE, GATE_RECORD
from engineering.learning.retrospective import AgentRecord, GateVerdict, RunRecord, fit
from engineering.quality_gate.record import GateRecord
from engineering.rows import LAUNCH_HOLD, amount_attr, get_row, run_pk, run_rows, string_attr
from engineering.workspace.layout import parse_agent_key
from engineering.workspace.store import WorkspaceStore
from shared.logging import logger

#: The gate records one retrospective reads, at most.
MAX_GATE_RECORDS: Final = 20
#: The supervisor's last word on an agent's failure, as the retrospective keeps it.
LAST_FAILURE_CHARS: Final = 1_500
#: The open blocking findings a NO-GO's evidence names, at most.
MAX_GATE_REASONS: Final = 12


def _whole(item: Mapping[str, Any], key: str) -> int:
    return int(amount_attr(item, key))


def _last_failure(item: Mapping[str, Any]) -> str:
    """The run monitor's inspection data's ``last_failure`` and ``last_exit``, as one redacted line."""
    inspect = TypeDeserializer().deserialize(item['inspect']) if 'inspect' in item else {}
    if not isinstance(inspect, dict):
        return ''
    parts = [str(inspect.get('last_failure') or '')]
    last_exit = inspect.get('last_exit')
    if isinstance(last_exit, dict):
        parts.append(f"exit {last_exit.get('exit_code')}, timed out {last_exit.get('timed_out')}; "
                     f"stderr: {last_exit.get('stderr_tail') or ''!s}")
    return fit(' '.join(part for part in parts if part), LAST_FAILURE_CHARS)


def _agent(item: Mapping[str, Any]) -> AgentRecord:
    return AgentRecord(agent=string_attr(item, 'sk').removeprefix('AGENT#'), role=string_attr(item, 'role'),
                       skill_version=string_attr(item, 'skill_version'),
                       microvm_seconds=_whole(item, 'microvm_seconds'), cost_usd=amount_attr(item, 'cost_usd'),
                       crashes=_whole(item, 'crashes'), status=string_attr(item, 'status'),
                       last_failure=_last_failure(item))


def _verdict(task_id: str, attempt: int, record: GateRecord) -> GateVerdict:
    final = record.final_go
    open_blocking = [finding.title for finding in record.findings
                     if finding.blocking and record.outcome(finding)[0] == 'open']
    reasons = (*(final.reasons if final else ()), *(f'open blocking finding: {title}' for title in open_blocking))
    return GateVerdict(task_id=task_id, attempt=attempt, verdict=record.verdict,
                       no_go=record.verdict == 'NO-GO' or (final is not None and not final.go),
                       rounds=len(record.rounds), reasons=tuple(reasons[:MAX_GATE_REASONS]))


@dataclass(frozen=True)
class RunRecordReader:
    #: A low-level DynamoDB client on ``voc-engineering``.
    client: Any
    table: str
    workspace: WorkspaceStore

    def _gates(self, ws: str, run_id: str, board_tasks: Sequence[Task]) -> tuple[GateVerdict, ...]:
        """The gate records the run's final-go tasks named: only this run's own keys, of this workspace (the board
        keeps an agent to its own keys; a key naming another run or workspace is never read)."""
        keys: list[tuple[int, str, str]] = []
        for task in board_tasks:
            if task.role != FINAL_GO_ROLE:
                continue
            for raw in task.result_keys:
                key = parse_agent_key(raw)
                if (key is not None and (key.ws, key.run_id) == (ws, run_id) and key.kind == 'gate'
                        and key.name == GATE_RECORD):
                    keys.append((key.attempt, task.task_id, raw))
        verdicts: list[GateVerdict] = []
        for attempt, task_id, raw in sorted(keys, reverse=True)[:MAX_GATE_RECORDS]:
            text = self.workspace.read_text(raw)
            try:
                record = GateRecord.from_dict(json.loads(text)) if text is not None else None
            except ValueError:   # json.JSONDecodeError is one too
                record = None
            if record is None:
                logger.warning('learning: a gate record could not be read or is off the schema',
                               extra={'task_id': task_id, 'attempt': attempt})
                continue
            verdicts.append(_verdict(task_id, attempt, record))
        return tuple(verdicts)

    def read(self, ws: str, run_id: str) -> RunRecord | None:
        """The run's record, or None when the run does not exist."""
        meta = get_row(self.client, self.table, {'pk': {'S': run_pk(ws, run_id)}, 'sk': {'S': 'META'}})
        if meta is None:
            return None
        board = BoardStore(self.client, self.table, new_id=lambda: '')
        tasks = board.tasks(ws, run_id)
        agents = tuple(_agent(item) for item in run_rows(self.client, self.table, ws, run_id, 'AGENT#')
                       if 'seq' in item or LAUNCH_HOLD not in item)
        return RunRecord(ws=ws, run_id=run_id, connection=string_attr(meta, 'connection'),
                         status=string_attr(meta, 'status'), started_at=string_attr(meta, 'started_at'),
                         ended_at=string_attr(meta, 'ended_at'), tasks=tuple(tasks),
                         history=board.history(ws, run_id), agents=agents, gates=self._gates(ws, run_id, tasks))
