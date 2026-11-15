"""The board's GO ledger: which final-go task's gate record is the run's verdict, and whether that record is a GO.

One rule for the broker (``connectors/records.py``: a pull request only on a GO for the exact tree) and the run's flow
(``flow/record.py``: a quality gate step's ``pass`` or ``fail`` arrow). The final-go task that ended last (done,
failed or needing a person) decides, whatever an older one's record says, and of it the gate record its holder
recorded last (``_gate/attempt-<n>/record.json`` under that final-go agent's own keys). Only a task that ended done
with a record that reads as a GO (verdict GO, the final go's own GO, no stop) is a GO, and only when the gate runner
task that ended last ended done with a GO record (its checks run and passed, no stop) on the same tree
(``go_tree``): a NO-GO record, a record that is missing, unreadable or off ``voc-gate-record/1``, a task that ended
any other way, and a final go's GO after a gate runner's NO-GO, STOPPED, failure or other tree are not. The board
takes a final go's task only after such a gate runner's GO (``checked_go``, ``board/flow_guard.py``).
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
GATE_RUNNER_ROLE: Final = 'gate-runner'
#: The largest gate record the ledger reads (a record over it is no GO).
MAX_GATE_RECORD_BYTES: Final = 1024 * 1024

ReadRecord = Callable[[str], GateRecord | None]


def newest_ended(tasks: Iterable[Task], role: str) -> Task | None:
    """The ``role`` task that ended last (by its last update, then its attempt), or None when none has ended."""
    ended = [task for task in tasks if task.role == role and task.state in FINAL]
    return max(ended, key=lambda task: (task.updated_at, task.attempt)) if ended else None


def newest_record(tasks: Iterable[Task], ws: str, run_id: str, role: str) -> tuple[Task, str] | None:
    """The ``role`` task (a final go's, a gate runner's) that ended last and the key of its holder's latest gate
    record ('' for none), or None when no such task has ended."""
    newest = newest_ended(tasks, role)
    if newest is None:
        return None
    found: list[tuple[int, str]] = []
    for raw in newest.result_keys:
        key = parse_agent_key(raw)
        # The task's own holder's record (the board took only its keys), an agent's of that role (the IAM grants
        # read the final go's and the gate runner's gate records only).
        if key is not None and (key.ws, key.run_id, key.kind, key.name, key.agent) == (
                ws, run_id, 'gate', GATE_RECORD, newest.lease_agent) and key.agent.startswith(f'{role}-'):
            found.append((key.attempt, raw))
    return newest, max(found)[1] if found else ''


def newest_final_go(tasks: Iterable[Task], ws: str, run_id: str) -> tuple[Task, str] | None:
    """The final-go task that ended last and the key of its holder's latest gate record ('' for none), or None when
    no final-go task has ended."""
    return newest_record(tasks, ws, run_id, FINAL_GO_ROLE)


def is_go(record: GateRecord | None) -> bool:
    """The record says GO: its verdict, the final go's own answer, and no stop."""
    return (record is not None and record.verdict == 'GO' and record.final_go is not None and record.final_go.go
            and not record.stop_reason)


def is_checked_go(record: GateRecord | None, tree: str) -> bool:
    """A gate runner's record says GO for ``tree``: its verdict, no stop, no final go section (never its to give),
    at least one check and every check passed, on exactly that tree."""
    return (record is not None and record.verdict == 'GO' and not record.stop_reason and record.final_go is None
            and bool(tree) and record.tree_hash == tree and any(r.checks for r in record.rounds)
            and all(r.checks_passed for r in record.rounds))


def checked_go(tasks: Iterable[Task], ws: str, run_id: str, read: ReadRecord) -> GateRecord | None:
    """The gate runner's GO record the final go may judge on: the record of the gate runner task that ended last,
    when it ended done and its record says GO (``is_checked_go`` on its own tree), else None. The board takes a final
    go's task only after one (``board/flow_guard.py``)."""
    latest = newest_record(tasks, ws, run_id, GATE_RUNNER_ROLE)
    if latest is None or latest[0].state != DONE or not latest[1]:
        return None
    record = read(latest[1])
    return record if record is not None and is_checked_go(record, record.tree_hash) else None


def go_tree(tasks: Iterable[Task], ws: str, run_id: str, read: ReadRecord) -> tuple[Task, str] | None:
    """The deciding final go and the tree its GO stands for ('' for no GO), or None when no final-go task ended.

    The one rule the board's flow, the conductor and the broker share: the final-go task that ended last decides, and
    it is a GO only when it ended done with a GO record, and the gate runner task that ended last (of the same tasks)
    ended done with a GO record on the same tree: a final go's GO after a gate runner's NO-GO, STOPPED or failure, or
    for another tree, is no GO."""
    listed = list(tasks)
    latest = newest_final_go(listed, ws, run_id)
    if latest is None:
        return None
    task, key = latest
    record = read(key) if task.state == DONE and key else None
    if record is None or not is_go(record) or not record.tree_hash:
        return task, ''
    checked = checked_go(listed, ws, run_id, read)
    return task, record.tree_hash if checked is not None and checked.tree_hash == record.tree_hash else ''


def verdict(tasks: Iterable[Task], ws: str, run_id: str, read: ReadRecord) -> tuple[str, str] | None:
    """``('go' | 'no_go', the deciding task's id)`` for these tasks, or None when no final-go task of them has ended
    (``go_tree``'s rule)."""
    decided = go_tree(tasks, ws, run_id, read)
    if decided is None:
        return None
    task, tree = decided
    return ('go' if tree else 'no_go'), task.task_id


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
