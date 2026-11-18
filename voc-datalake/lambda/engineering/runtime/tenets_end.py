"""A Tenets run's end (7.52.00): the understander's ``voc-tenets/1`` record drafted as the connection's next tenets
version (``knowledge/tenets.py``), for an administrator to accept or reject.

At an ended run's retrospective (``handler._retrospect``, beside the triage's copy), for a run whose META names its
connection: the newest done understander task's recorded tenets
(``ws/<ws>/runs/<run>/understander-<n>/commits/<sha>/_tenets/attempt-<k>/tenets.json``, a key the board recorded on the
task, never a listing), read from the workspace bucket, its text made safe (``knowledge/notes.safe_text``: credentials
and personal data replaced, one line each) and checked again (``outputs.tenets_record``: what an agent wrote is data),
is drafted with its author (the agent) and its run (``TenetsStore.draft``). Once per run: its ``TENETSRUN#`` row is
create-only, so a retrospective run again drafts nothing more (``kept``). A run with no recorded tenets drafts nothing.

Never raises: whatever fails is logged by ids only (never the record's text) and answered, so the retrospective goes
on.
"""
from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any, Final

from engineering.board.model import Task
from engineering.connectors.identity import WORKSPACE
from engineering.rows import string_attr
from engineering.runtime.outputs import (
    MAX_TENET_TEXT,
    MAX_TENET_TITLE,
    MAX_TENETS_SUMMARY,
    TENETS_FILE,
    TenetsError,
    tenets_record,
)
from engineering.runtime.triage_end import (
    FAILED,
    ended_meta,
    never_raising,
    newest_recorded,
    run_end_stores,
    run_tasks,
)
from shared.logging import logger

#: The largest tenets record read (its bounded fields fit in a few tens of kilobytes).
MAX_TENETS_BYTES: Final = 128 * 1024
#: What ``draft_tenets`` answers (and ``triage_end.FAILED``).
DRAFTED, KEPT, NO_CONNECTION, NO_TENETS, NOT_ENDED, INVALID = (
    'drafted', 'kept', 'no_connection', 'no_tenets', 'not_ended', 'invalid')


def newest_tenets(tasks: Sequence[Task], run_id: str) -> tuple[Task, str] | None:
    """The newest done understander task's tenets key (by its last change), None when no task recorded one."""
    return newest_recorded(tasks, run_id, 'tenets', TENETS_FILE)


def safe_record(raw: Mapping[str, Any]) -> dict[str, object]:
    """``raw``'s text made safe (redacted, one line each), then checked as a ``voc-tenets/1`` record."""
    from engineering.knowledge.notes import safe_text

    def safe(value: object, limit: int) -> object:
        return safe_text(value, limit) if isinstance(value, str) else value

    tenets = raw.get('tenets')
    cleaned = [{**tenet, 'title': safe(tenet.get('title'), MAX_TENET_TITLE),
                'statement': safe(tenet.get('statement'), MAX_TENET_TEXT),
                'rationale': safe(tenet.get('rationale', ''), MAX_TENET_TEXT)}
               if isinstance(tenet, dict) else tenet for tenet in (tenets if isinstance(tenets, list) else [])]
    return tenets_record({**raw, 'tenets': cleaned if isinstance(tenets, list) else tenets,
                          'summary': safe(raw.get('summary', ''), MAX_TENETS_SUMMARY)})


def draft_tenets(run_id: str, *, client: Any, table: str, workspace: Any, store: Any) -> str:
    """The ended run's tenets drafted (the module's doc); what came of it. Never raises."""
    return never_raising(run_id, 'tenets', lambda: _draft(run_id, client=client, table=table, workspace=workspace,
                                                          store=store))


def _draft(run_id: str, *, client: Any, table: str, workspace: Any, store: Any) -> str:
    from engineering.knowledge.store import Actor, PackError

    meta = ended_meta(client, table, run_id)
    if meta is None:
        return NOT_ENDED
    connection = string_attr(meta, 'connection')
    if not connection:
        return NO_CONNECTION
    found = newest_tenets(run_tasks(client, table, run_id),
                          run_id)
    if found is None:
        return NO_TENETS
    _task, key = found
    body = workspace.read_bytes(key, MAX_TENETS_BYTES)
    if body is None:
        logger.warning('engineering tenets: the recorded tenets are missing', extra={'run_id': run_id, 'key': key})
        return NO_TENETS
    try:
        loaded = json.loads(body)
        record = safe_record(loaded if isinstance(loaded, dict) else {})
    except (TenetsError, ValueError):
        logger.warning('engineering tenets: the recorded tenets are off their shape', extra={'run_id': run_id,
                                                                                            'key': key})
        return INVALID
    agent = key.split('/')[4]
    try:
        drafted = store.draft(WORKSPACE, connection, record, author=Actor(agent, 'agent', connection=connection),
                              run_id=run_id)
    except PackError:
        logger.exception('engineering tenets: the draft was refused', extra={'run_id': run_id})
        return INVALID
    if drafted is None:
        logger.info('engineering tenets: the run drafted its tenets already', extra={'run_id': run_id})
        return KEPT
    logger.info('engineering tenets: a draft recorded', extra={'run_id': run_id, 'connection_id': connection,
                                                               'version': drafted.version,
                                                               'tenets': len(drafted.ids)})
    return DRAFTED


def draft_tenets_at_end(run_id: str) -> str:
    """``draft_tenets`` on this function's clients (voc-engineering-runtime: its table and its workspace bucket);
    ``failed`` where the deployment names neither. Never raises."""
    try:
        from engineering.knowledge.tenets import TenetsStore
        client, table, workspace = run_end_stores()
        return draft_tenets(run_id, client=client, table=table, workspace=workspace, store=TenetsStore(client, table))
    except Exception:
        logger.exception('engineering tenets: the draft could not start', extra={'run_id': run_id})
        return FAILED
