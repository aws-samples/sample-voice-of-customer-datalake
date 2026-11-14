"""The board's GO ledger: which final-go task's gate record is the run's verdict, and whether that record is a GO.

One rule for the broker (``connectors/records.py``: a pull request only on a GO for the exact tree) and the run's flow
(``flow/record.py``: a quality gate step's ``pass`` or ``fail`` arrow). The final-go task that ended last (done,
failed or needing a person) decides, whatever an older one's record says, and of it the gate record its holder
recorded last (``_gate/attempt-<n>/record.json`` under that final-go agent's own keys). Only a task that ended done
with a record that reads as a GO (verdict GO, the final go's own GO, no stop) is a GO: a NO-GO record, a record that
is missing, unreadable or off ``voc-gate-record/1``, and a task that ended any other way are not.
"""
from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from typing import Final

from engineering.board.model import DONE, FINAL, Task
from engineering.quality_gate.record import GateRecord
from engineering.workspace.layout import parse_agent_key
from engineering.workspace.store import ObjectTooLarge, WorkspaceStore
from shared.logging import logger

#: A gate record's object name (``workspace/layout.py``: ``…/_gate/attempt-<n>/record.json``).
GATE_RECORD: Final = 'record.json'
FINAL_GO_ROLE: Final = 'final-go'
#: The largest gate record the ledger reads (a record over it is no GO).
MAX_GATE_RECORD_BYTES: Final = 1024 * 1024

ReadRecord = Callable[[str], GateRecord | None]


def newest_final_go(tasks: Iterable[Task], ws: str, run_id: str) -> tuple[Task, str] | None:
    """The final-go task that ended last and the key of its holder's latest gate record ('' for none), or None when
    no final-go task has ended."""
    ended = [task for task in tasks if task.role == FINAL_GO_ROLE and task.state in FINAL]
    if not ended:
        return None
    newest = max(ended, key=lambda task: (task.updated_at, task.attempt))
    found: list[tuple[int, str]] = []
    for raw in newest.result_keys:
        key = parse_agent_key(raw)
        # The task's own holder's record (the board took only its keys), a final-go agent's (the IAM grants read no
        # other agent's gate records).
        if key is not None and (key.ws, key.run_id, key.kind, key.name, key.agent) == (
                ws, run_id, 'gate', GATE_RECORD, newest.lease_agent) and key.agent.startswith(f'{FINAL_GO_ROLE}-'):
            found.append((key.attempt, raw))
    return newest, max(found)[1] if found else ''


def is_go(record: GateRecord | None) -> bool:
    """The record says GO: its verdict, the final go's own answer, and no stop."""
    return (record is not None and record.verdict == 'GO' and record.final_go is not None and record.final_go.go
            and not record.stop_reason)


def verdict(tasks: Iterable[Task], ws: str, run_id: str, read: ReadRecord) -> tuple[str, str] | None:
    """``('go' | 'no_go', the deciding task's id)`` for these tasks, or None when no final-go task of them has ended.
    Only the deciding task's own record is read."""
    latest = newest_final_go(tasks, ws, run_id)
    if latest is None:
        return None
    task, key = latest
    go = task.state == DONE and bool(key) and is_go(read(key))
    return ('go' if go else 'no_go'), task.task_id


def read_gate_record(workspace: WorkspaceStore, key: str) -> GateRecord | None:
    """A gate record as written, or None when it is missing, over its bound or off its schema (no GO, said in the
    log); a read the store fails (``ClientError``) is raised for the caller to answer."""
    try:
        body = workspace.read_bytes(key, MAX_GATE_RECORD_BYTES)
        return None if body is None else GateRecord.from_dict(json.loads(body.decode('utf-8')))
    except ObjectTooLarge:
        logger.warning('engineering: a gate record over its bound is no GO', extra={'key': key})
        return None
    except (ValueError, RecursionError):   # (off the schema, or nested past what json reads)
        logger.warning('engineering: a gate record off its schema is no GO', extra={'key': key})
        return None
